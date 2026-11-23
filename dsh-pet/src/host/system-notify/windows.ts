/**
 * Windows 系统通知读取：只读 Windows 通知平台的本地库，取出新增的 toast 通知。
 *
 * 数据源是 `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`——Windows 通知平台自己的存储，
 * 直接 readOnly 打开即可（WAL 副文件由 SQLite 自己处理并发，不需要复制快照）。
 * 只有 Windows 有这个库；其他平台本模块不提供实现（调用方按平台择路）。
 *
 * 实测确认的四条平台事实（改动前请重新验证，Windows 升级可能改表结构）：
 * ① 一条通知在库里存两份：`toast`（真弹窗，Payload 是 toast XML）与 `toastCondensed`（压缩副本，Payload 为 null），
 *    只取 `toast`，否则同一条会被读两遍；`tile`（磁贴）与 `badge`（角标）不是弹窗，一律不取。
 * ② `Notification.Id` 全局唯一，但**不与写入顺序同步**——`toastCondensed` 的 Id 会比相邻的 toast 小
 *    （实测 Order=13604 的 toast Id=11074，其后 Order=13629 的 condensed Id=11041）。
 *    但按 Id 升序时 `ArrivalTime` 严格单调，所以「Id 排序 + ArrivalTime 判新旧」才成立。
 * ③ `Order` 严格递增但有跳空（实测 235 行里 138 处），它是写入序号不是时间，不能当水位线。
 * ④ `ArrivalTime` 是 FILETIME（100ns 自 1601-01-01），不是 Unix 毫秒。
 *
 * 水位线按**类型分开记**：toast 与 toastCondensed 是两套独立的 Id 序列，
 * 拿全表 MAX(Id) 当水位线会把还没读的 toast 顶过去（实测：全表 MAX=11398 时，65 条 toast 已全部 ≤ 水位线）。
 *
 * `node:sqlite` 是运行时才按需加载的（见 loadSqlite）：宿主可能是 Electron 的老 Node，
 * 那里根本没有这个内置模块，静态 import 会让整个插件加载不起来。
 *
 * 本模块只负责取，不负责说（说什么见 ./notify-text.ts）。
 * @module dsh-pet/src/host/system-notify/windows
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SystemNotification } from './notify-text.ts';

/** Windows 通知库相对路径（相对用户目录）。 */
export const WPN_DB_RELATIVE_PATH = join('AppData', 'Local', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');

/** 通知库全路径（当前用户目录）。 */
export function wpnDatabasePath(): string {
  return join(homedir(), WPN_DB_RELATIVE_PATH);
}

/** FILETIME 纪元与 Unix 纪元之差（100ns 单位）：1601-01-01 到 1970-01-01。 */
const FILETIME_EPOCH_OFFSET_100NS = 116444736000000000n;

/**
 * FILETIME（100ns 自 1601）→ Unix 毫秒。
 *
 * @param fileTime - 库里的 ArrivalTime 原值。
 * @returns Unix 毫秒；值非法时返回 null。
 */
export function fileTimeToUnixMs(fileTime: bigint): number | null {
  if (fileTime < FILETIME_EPOCH_OFFSET_100NS) return null;
  const ms = (fileTime - FILETIME_EPOCH_OFFSET_100NS) / 10000n;
  return Number(ms);
}

/**
 * 从 toast XML 载荷里取标题与正文。
 *
 * 只认 `<text>` 元素：ToastGeneric 模板给两个（id=1 标题、id=2 正文），ToastText02 同理；
 * 取到的第一个当标题、第二个当正文，多余的忽略。CDATA 与 XML 实体一并剥掉。
 *
 * @param xml - Payload 解出的 XML 文本。
 * @returns 标题与正文；取不到文本时两个都是空串。
 */
export function parseToastXml(xml: string): { title: string; body: string } {
  const texts: string[] = [];
  const pattern = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  let matched = pattern.exec(xml);
  while (matched !== null) {
    texts.push(decodeXmlText(matched[1]));
    matched = pattern.exec(xml);
  }
  return { title: texts[0] ?? '', body: texts[1] ?? '' };
}

/** XML 文本节点的解码：剥 CDATA 包裹、解常用实体、压空白。 */
function decodeXmlText(raw: string): string {
  let text = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  text = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
  return text.replace(/\s+/g, ' ').trim();
}

/** 库里的通知行（只取用得到的列；列名与 SQL 里的别名一致）。 */
interface WpnRow {
  readonly id: bigint;
  readonly handlerId: bigint;
  readonly type: string;
  readonly payload: Uint8Array | null;
  readonly arrivalTime: bigint;
}

/** 一条待转述的通知（已解析出文案所需字段）。 */
export interface WindowsSystemNotification extends SystemNotification {
  /** 通知库里的 Id：增量水位线用。 */
  readonly id: number;
  /** 到达时刻（Unix 毫秒）；库里的值异常时为 null。 */
  readonly arrivedAt: number | null;
}

/** 读取器的对外形状（测试可注入替身）。 */
export interface WindowsNotificationReader {
  /** 取比 `afterId` 更大的新增 toast 通知，按到达时刻升序。 */
  readSince(afterId: number): WindowsSystemNotification[];
  /** 当前库里最大的 toast Id（没有 toast 时返回入参）。 */
  maxToastId(afterId: number): number;
  /** 关闭底层库句柄。 */
  close(): void;
}

/** 读库失败时的兜底句柄：读不到就是读不到，不抛。 */
const EMPTY_READER: WindowsNotificationReader = {
  readSince: () => [],
  maxToastId: (afterId: number) => afterId,
  close: () => {},
};

/** sqlite 的最小形状：只声明本模块用到的方法，避免把内置模块的类型搬进来。 */
interface SqliteStatement {
  setReadBigInts(enabled: boolean): void;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/**
 * 按需加载 `node:sqlite`。
 *
 * 用 createRequire 而不是静态 import：宿主可能跑在 Electron 的老 Node 上，那里没有这个内置模块，
 * 静态 import 会直接让整个插件加载失败——读不到通知只是少个功能，不该连累插件起不来。
 */
function loadSqlite(): SqliteModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

/**
 * 打开 Windows 通知库。
 *
 * 库被系统进程持有写锁，但 SQLite 支持并发读，所以直接 readOnly 打开原库即可（不必复制快照）。
 * 打不开、或运行环境没有 `node:sqlite` 时返回空读器——通知接入是锦上添花，不该让整个插件起不来。
 *
 * @param dbPath - 通知库路径；缺省用当前用户目录下的默认位置。
 * @returns 读器；打不开时是空读器。
 */
export function openWindowsNotifications(dbPath: string = wpnDatabasePath()): WindowsNotificationReader {
  const sqlite = loadSqlite();
  if (sqlite === null) return EMPTY_READER;
  let db: SqliteDatabase;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return EMPTY_READER;
  }
  try {
    const handlers = readHandlers(db);
    return {
      readSince: (afterId: number) => readToasts(db, handlers, afterId),
      maxToastId: (afterId: number) => readMaxToastId(db, afterId),
      close: () => db.close(),
    };
  } catch {
    db.close();
    return EMPTY_READER;
  }
}

/** 来源应用标识表：handlerId → PrimaryId。 */
function readHandlers(db: SqliteDatabase): Map<string, string> {
  const out = new Map<string, string>();
  const stmt = db.prepare('SELECT RecordId, PrimaryId FROM NotificationHandler');
  stmt.setReadBigInts(true);
  for (const row of stmt.all() as Array<{ RecordId: bigint; PrimaryId: string | null }>) {
    out.set(String(row.RecordId), String(row.PrimaryId ?? ''));
  }
  return out;
}

/**
 * 取比 `afterId` 更大的 toast 行。
 *
 * 只取 `toast` 类型（见文件头的实测事实①）；`toastCondensed` 是同一条通知的压缩副本。
 * 排序按 ArrivalTime 升序——先到的先说（Id 与写入顺序不同步，不能拿 Id 排序，见文件头②）。
 */
function readToasts(db: SqliteDatabase, handlers: Map<string, string>, afterId: number): WindowsSystemNotification[] {
  const stmt = db.prepare(
    'SELECT Id AS id, HandlerId AS handlerId, Type AS type, Payload AS payload, ArrivalTime AS arrivalTime' +
      ' FROM Notification WHERE Id > ? AND Type = ? ORDER BY Id ASC',
  );
  stmt.setReadBigInts(true);
  const rows = stmt.all(afterId, 'toast') as unknown as WpnRow[];
  const out: WindowsSystemNotification[] = [];
  for (const row of rows) {
    const payload = row.payload;
    if (payload === null || payload === undefined) continue;
    const xml = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
    const { title, body } = parseToastXml(xml);
    if (title === '' && body === '') continue;
    out.push({
      id: Number(row.id),
      appId: handlers.get(String(row.handlerId)) ?? '',
      title,
      body,
      arrivedAt: fileTimeToUnixMs(row.arrivalTime),
    });
  }
  // 按到达时刻排：同一毫秒内以 Id 兜底定序，保证顺序稳定
  out.sort((a, b) => (a.arrivedAt ?? 0) - (b.arrivedAt ?? 0) || a.id - b.id);
  return out;
}

/**
 * 库里最大的 **toast** Id（不是全表最大值）。
 *
 * 必须按类型分开取：toast 与 toastCondensed 是两套独立 Id 序列，
 * 拿全表 MAX(Id) 当水位线会把还没读的 toast 顶过去（见文件头实测结论）。
 */
function readMaxToastId(db: SqliteDatabase, fallback: number): number {
  const stmt = db.prepare('SELECT MAX(Id) AS maxId FROM Notification WHERE Type = ?');
  stmt.setReadBigInts(true);
  const row = stmt.get('toast') as unknown as { maxId: bigint | null };
  return row.maxId === null ? fallback : Number(row.maxId);
}
