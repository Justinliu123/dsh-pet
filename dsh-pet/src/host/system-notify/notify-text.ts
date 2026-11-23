/**
 * 系统通知 → 她要说的文案：纯函数，不碰 IO、不读时钟。
 * 与 Windows 读取层（./windows.ts）分开：那边只负责「取到什么」，这里只负责「要不要说、怎么说」。
 * @module dsh-pet/src/host/system-notify/notify-text
 */

/** 一条系统通知（已从平台层归一化）。 */
export interface SystemNotification {
  /** 来源应用的系统标识（如 `org.yuanli.utools`、`electron.app.DSH NEXT`）。 */
  readonly appId: string;
  /** 通知标题；平台未提供时为空串。 */
  readonly title: string;
  /** 通知正文；平台未提供时为空串。 */
  readonly body: string;
}

/** DSH 自己的来源标识：会话事件帧归它，Windows 通知库里的 DSH 通知也归它。 */
export const DSH_APP_ID = 'electron.app.DSH';

/** 正文进气泡前的长度上限（字符）：超长只留开头，避免一条长消息把气泡撑爆。 */
export const MAX_BODY_CHARS = 40;

/** 正文截断（超长只留前 MAX_BODY_CHARS 字符并加省略号）。 */
export function truncateBody(body: string): string {
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '…' : body;
}

/**
 * 来源是不是 DSH（含本插件与 DSH 宿主自身）。
 *
 * 这些通知由 DSH 侧发起，DSH 自己已经有一套通知通路；她再转述一遍就是同一件事说两遍。
 * 判据取应用标识的前缀——DSH 的 Electron 壳标识是 `electron.app.DSH NEXT`，
 * 本插件在 DSH 里跑时也用这个标识。
 *
 * 只用于**系统通知库**那条路：会话事件帧虽然也来自 DSH，但那是「DSH 的事转给她说」，
 * 恰恰要转述，不在这里挡。
 */
export function isDshSource(appId: string): boolean {
  return appId.startsWith('electron.app.DSH');
}

/** 该不该让她说这条通知（内容够不够说）。 */
export function shouldRelay(notification: SystemNotification): boolean {
  // 标题正文都空的没有可说的内容
  return notification.title.trim() !== '' || notification.body.trim() !== '';
}

/**
 * 应用标识 → 说话时用的来源名。
 *
 * 系统标识长得不像人话（`org.yuanli.utools`、`com.minimax.agent.cn`），直接念出来用户听不懂。
 * 常见标识走查表；认不出的取末段，末段还是通用域名后缀就干脆不念来源名。
 *
 * @param appId - 来源应用的系统标识。
 * @returns 说话用的来源名；认不出时返回空串。
 */
export function sourceName(appId: string): string {
  const known: Record<string, string> = {
    [DSH_APP_ID]: 'DSH',
    'org.yuanli.utools': 'uTools',
    'com.minimax.agent.cn': 'MiniMax',
    QQ: 'QQ',
    'com.tencent.wechat': '微信',
    WeChat: '微信',
    'Microsoft.Windows.PowerShell': 'PowerShell',
    Chrome: 'Chrome',
  };
  const hit = known[appId];
  if (hit !== undefined) return hit;
  // 商店应用的 AUMID 形如 `Microsoft.WindowsStore_xxx!App`：前半是包族名，不是能念的名字
  if (appId.includes('!')) return '';
  const tail = appId.split('.').pop() ?? '';
  // 末段是 com/cn/net/org/io 这类通用后缀，说明认不出应用名
  if (tail.length < 2 || /^(com|cn|net|org|io|dev|app)$/i.test(tail)) return '';
  return tail;
}

/**
 * 通知 → 她要说的一句话。
 *
 * 形态：`来源：标题 —— 正文`；哪一段没有就省掉，冒号与破折号都不会悬空。
 * 正文为空时不补占位文案——内容不够就是不够，不编。
 *
 * @param notification - 已归一化的系统通知。
 * @returns 她要说的整句话；不该转述时返回空串。
 */
export function notificationSpeech(notification: SystemNotification): string {
  if (!shouldRelay(notification)) return '';
  const source = sourceName(notification.appId);
  const title = notification.title.trim();
  const body = truncateBody(notification.body.trim());
  const head = [source, title].filter((part) => part !== '').join('：');
  if (head === '') return body;
  if (body === '') return head;
  return head + ' —— ' + body;
}
