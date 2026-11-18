/**
 * DSH 宿主 → 独立桌宠的描述文件：把「本宿主在哪」写给同机的独立应用。
 *
 * 为什么需要：DSH 的 Web 端口每次启动随机（配置里 port=0），独立应用没法靠端口扫出宿主；
 * 又不能用固定端口——DSH 可能同时在跑多个实例。写一份带 pid 的描述文件是唯一稳定的发现方式。
 * 只写回环入口、pid 与时间戳：不含凭据，不落任何 secret。
 * 不负责：判断对方是否活着（那是 app-presence 的事）、镜像数据（那是独立应用 dsh-bridge 的事）。
 * 始终成立：写入走「临时文件 + rename」，读方永远看不到写了一半的 JSON。
 *
 * @module dsh-pet/src/host/plugin/bridge-descriptor
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 描述文件名：放在插件数据根，与日志、独立应用存活标记同级。 */
export const BRIDGE_DESCRIPTOR_FILE = 'standalone-bridge.json';

/** 描述文件格式版本：形状变了就递增，读到不认识的版本一律当「没有桥」。 */
export const BRIDGE_DESCRIPTOR_VERSION = 1;

export interface BridgeDescriptor {
  readonly version: typeof BRIDGE_DESCRIPTOR_VERSION;
  /** 宿主入口（originated from ctx.webServer.getOrigin()），独立应用据此拼 /state。 */
  readonly origin: string;
  /** 写文件的 DSH 进程 pid：宿主重启后旧文件被覆盖，清理时也靠它判断「是不是我写的」。 */
  readonly pid: number;
  readonly startedAt: number;
}

export function bridgeDescriptorPath(userRoot: string): string {
  return join(userRoot, BRIDGE_DESCRIPTOR_FILE);
}

/**
 * 只认 http(s) 且能解析的入口：文件在本机可写，不值得把请求发给奇怪协议或无主机名的地址。
 */
export function normalizeBridgeOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** 严格校验：任何字段不对都返回 undefined，调用方按「没有桥」处理，不做部分信任。 */
export function parseBridgeDescriptor(raw: unknown): BridgeDescriptor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== BRIDGE_DESCRIPTOR_VERSION) return undefined;
  const origin = normalizeBridgeOrigin(obj.origin);
  const pid = obj.pid;
  const startedAt = obj.startedAt;
  if (origin === undefined) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  return { version: BRIDGE_DESCRIPTOR_VERSION, origin, pid, startedAt };
}

/** 写描述文件（原子替换）。origin 非法时抛错：这是宿主 bug，不能静默写一份没人能用的文件。 */
export function writeBridgeDescriptor(
  userRoot: string,
  origin: string,
  options: { pid?: number; startedAt?: number } = {},
): BridgeDescriptor {
  const normalized = normalizeBridgeOrigin(origin);
  if (normalized === undefined) throw new Error(`无效的宿主入口：${origin}`);
  const descriptor: BridgeDescriptor = {
    version: BRIDGE_DESCRIPTOR_VERSION,
    origin: normalized,
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? Date.now(),
  };
  const file = bridgeDescriptorPath(userRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return descriptor;
}

/** 读描述文件；不存在、坏 JSON、版本不认都返回 undefined。 */
export function readBridgeDescriptor(userRoot: string): BridgeDescriptor | undefined {
  try {
    return parseBridgeDescriptor(JSON.parse(readFileSync(bridgeDescriptorPath(userRoot), 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * 删除描述文件，但只在它仍属于指定 pid 时删：
 * DSH 重启后新进程会先写新描述，旧进程收尾时不能把新的删掉。
 */
export function removeBridgeDescriptor(userRoot: string, pid: number = process.pid): void {
  const current = readBridgeDescriptor(userRoot);
  if (current === undefined || current.pid !== pid) return;
  try {
    rmSync(bridgeDescriptorPath(userRoot), { force: true });
  } catch {
    // 退出路径上尽力而为：删不掉最多留一份过期描述，独立应用会因 pid 不活而忽略。
  }
}

/** announceDshBridge 只依赖这几个 ctx 成员，避免把 Cordis 类型拖进纯模块。 */
export interface BridgeAnnounceContext {
  readonly webServer?: {
    /** 真实宿主有；独立应用的伪 webServer 只有 port/register，因此这里同时充当「我是不是宿主」的判据。 */
    getOrigin?: () => unknown;
  };
  readonly effect?: (callback: () => (() => void) | void, label: string) => unknown;
}

export interface AnnounceBridgeInput {
  readonly ctx: BridgeAnnounceContext;
  readonly userRoot: string;
  readonly log: { info(message: string): void; warn?(message: string): void };
}

/** 首次公布失败后的重试间隔：WebServer 的 listen 与插件 apply 谁先完成不确定，只能等。 */
export const ANNOUNCE_RETRY_MS = 250;

/** 最多重试多少次（15 秒）：再晚还没 listen 完，就不是「还没起来」而是宿主坏了。 */
export const ANNOUNCE_MAX_ATTEMPTS = 60;

/**
 * 读一次宿主入口。
 *
 * 两个坑都在这里兜住：① `ctx.webServer.getOrigin` 必须用 `call(webServer)` 调，摘出来裸调会丢 this；
 * ② 它在 listen 绑定端口之前会抛错（宿主文档明确写了），所以在 apply 期间第一次多半失败。
 */
function readHostOrigin(webServer: NonNullable<BridgeAnnounceContext['webServer']>): string | undefined {
  const getOrigin = webServer.getOrigin;
  if (typeof getOrigin !== 'function') return undefined;
  try {
    return normalizeBridgeOrigin(getOrigin.call(webServer));
  } catch {
    return undefined;
  }
}

/**
 * 在 DSH 宿主里公布入口：独立应用每秒读它来发现本宿主。
 *
 * 只在「有 getOrigin 的宿主 WebServer」里公布——独立应用自己的伪 webServer 没有 getOrigin，
 * 这样同一份 apply() 两边跑也不会在独立应用里写出指向自己的描述文件。
 *
 * 只公布一次是不够的：插件 apply 往往早于 WebServer 的 listen，入口当时取不到；所以在这里按
 * {@link ANNOUNCE_RETRY_MS} 重试到 {@link ANNOUNCE_MAX_ATTEMPTS} 次，拿到就写文件并停表。
 * 停止/卸载时撤掉描述文件，免得独立应用对着一个已死的端口每秒重试（定时器一并清掉）。
 */
export function announceDshBridge(input: AnnounceBridgeInput): BridgeDescriptor | undefined {
  if (process.env.DSH_PET_APP_MODE === '1' || process.env.DSH_PET_IN_PROCESS === '1') return undefined;
  const webServer = input.ctx.webServer;
  if (webServer === undefined || typeof webServer.getOrigin !== 'function') return undefined;

  let published: BridgeDescriptor | undefined;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = (): void => {
    if (published !== undefined) return;
    attempts += 1;
    const origin = readHostOrigin(webServer);
    if (origin === undefined) {
      if (attempts >= ANNOUNCE_MAX_ATTEMPTS) {
        input.log.warn?.(
          `[dsh-pet] DSH 桥公布入口失败：重试 ${attempts} 次仍取不到 WebServer 入口，独立桌宠将连不上本宿主`,
        );
        timer = undefined;
        return;
      }
      timer = setTimeout(attempt, ANNOUNCE_RETRY_MS);
      timer.unref?.();
      return;
    }
    timer = undefined;
    try {
      published = writeBridgeDescriptor(input.userRoot, origin);
    } catch (error) {
      input.log.warn?.(`[dsh-pet] DSH 桥写描述文件失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    input.log.info(`[dsh-pet] DSH 桥已公布宿主入口：${published.origin}（独立桌宠会发现并接入会话工作状态）`);
  };

  attempt();
  // 插件卸载/DSH 退出时撤掉，免得独立应用对着一个已死的端口每秒重试。
  input.ctx.effect?.(
    () => () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (published !== undefined) removeBridgeDescriptor(input.userRoot, published.pid);
    },
    'dsh-pet: bridge descriptor',
  );
  return published;
}
