/**
 * DSH 入口的兜底发现：描述文件缺席时，从 DSH 自己的启动日志里认回环地址。
 *
 * 为什么需要兜底：宿主侧 `announceDshBridge` 要等 WebServer listen 完成才能取到 origin，而且只在
 * 插件加载时公布一次；插件一直是禁用/旧版本、或描述文件被清掉时，独立桌宠就只能干等下一次 DSH 重启。
 * DSH 每次启动都会把入口打进 `~/.dsh/logs/desktop-next*.log`（`dsh web: http://127.0.0.1:<port>/?token=…`），
 * 读到它就是零成本发现——不用扫端口、不用改 DSH、也不用重启。
 *
 * 只读日志尾部固定字节数（默认 512KB）；日志按大小轮转，最新入口一定在尾部几条里。
 * 找到的地址不验证可用性：那由调用方发一次 GET /state 决定，失败就 invalidate 后等一轮再读。
 *
 * @module dsh-pet/src/standalone/dsh-endpoint
 */
import { readdirSync, readSync, statSync, closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeBridgeOrigin } from '../host/plugin/bridge-descriptor.ts';

/** 读日志尾部的默认字节数：够覆盖最近几轮启动，又不至于整份读进内存。 */
export const LOG_TAIL_BYTES = 512 * 1024;

/** 日志候选：DSH 桌面端写 desktop-next.log，轮转后是同前缀的编号/日期文件。 */
const DSH_LOG_PATTERN = /^desktop-next.*\.log$/;

/** 日志里入口行的标记；后面紧跟 URL。 */
const DSH_ORIGIN_PATTERN = /dsh web:\s*(https?:\/\/[^\s]+)/g;

/** 缓存有效期：日志最多每 10 秒重读一次，不给每秒一拍去翻 512KB。 */
export const LOG_PROBE_TTL_MS = 10_000;

/** 失败后的静默期：宿主没起来时不要每秒重读日志。 */
export const LOG_PROBE_BACKOFF_MS = 5_000;

/** 读文件尾部：文件小于上限时整读。 */
export function readTail(file: string, maxBytes: number = LOG_TAIL_BYTES): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

/**
 * 找最新的 DSH 日志文件。
 * @param logsDir - `~/.dsh/logs`。
 * @returns 最新日志的绝对路径；目录不存在或没有候选时 undefined。
 */
export function newestDshLog(logsDir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const name of names) {
    if (!DSH_LOG_PATTERN.test(name)) continue;
    const file = join(logsDir, name);
    try {
      const mtime = statSync(file).mtimeMs;
      if (best === undefined || mtime > best.mtime) best = { file, mtime };
    } catch {
      // 轮转瞬间文件可能已被删：跳过即可。
    }
  }
  return best?.file;
}

/**
 * 从一份日志文本里取最后一次公布的入口（DSH 重启多次时只有最后一条有效）。
 * @param text - 日志尾部文本。
 * @returns 归一化后的 origin；没有匹配或地址不可信时 undefined。
 */
export function lastDshOrigin(text: string): string | undefined {
  let last: string | undefined;
  for (const match of text.matchAll(DSH_ORIGIN_PATTERN)) last = match[1];
  return last === undefined ? undefined : normalizeBridgeOrigin(last);
}

/** 解析器的可注入依赖，便于单测不碰真实文件系统。 */
export interface DshEndpointDeps {
  /** `~/.dsh`：日志在 `<dshHome>/logs`。 */
  readonly dshHome: string;
  readonly now?: () => number;
  readonly tailReader?: (file: string) => string;
  readonly logFinder?: (logsDir: string) => string | undefined;
}

/** 带缓存的入口解析器。 */
export interface DshEndpointResolver {
  /** 取一个候选入口；缓存在有效期内直接返回，宿主没起来时返回 undefined。 */
  resolve(): string | undefined;
  /** 声明上次拿到的入口不可用：下次 resolve 会重新读日志（并短暂静默）。 */
  invalidate(): void;
}

/**
 * 建入口解析器（不读盘：第一次 resolve 才读）。
 * @param deps - DSH 数据根与可替换的读盘函数。
 * @returns 解析器。
 */
export function createDshEndpointResolver(deps: DshEndpointDeps): DshEndpointResolver {
  const now = deps.now ?? Date.now;
  const tailReader = deps.tailReader ?? ((file: string) => readTail(file));
  const logFinder = deps.logFinder ?? newestDshLog;

  let cached: { origin: string; at: number } | undefined;
  let blockedUntil = 0;

  return {
    resolve(): string | undefined {
      const at = now();
      if (at < blockedUntil) return undefined;
      if (cached !== undefined && at - cached.at < LOG_PROBE_TTL_MS) return cached.origin;
      const file = logFinder(join(deps.dshHome, 'logs'));
      if (file === undefined) {
        cached = undefined;
        return undefined;
      }
      let origin: string | undefined;
      try {
        origin = lastDshOrigin(tailReader(file));
      } catch {
        origin = undefined;
      }
      cached = origin === undefined ? undefined : { origin, at };
      return origin;
    },
    invalidate(): void {
      cached = undefined;
      blockedUntil = now() + LOG_PROBE_BACKOFF_MS;
    },
  };
}
