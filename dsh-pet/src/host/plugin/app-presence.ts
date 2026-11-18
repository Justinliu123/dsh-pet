/**
 * 独立桌宠的存活标记：告诉同机的 DSH 宿主「已经有一只桌宠在渲染了，别再拉一套桌面 Helper」。
 *
 * 为什么需要：DSH 插件与独立应用读同一份 ~/.dsh/dsh-pet/main-config.jsonc，不能用 display 只关一边；
 * 而两边都 startHelper 会出现两只宠物、两套托盘、两份碰撞物理。
 * 形状：pid + startedAt + 心跳。单看 pid 会被「pid 复用」骗，所以还要求心跳新鲜（默认 90s）——
 * 独立应用每 30s 刷一次，宿主在 90s 内看到过心跳才认为它还活着。
 * 不负责：桥接数据（那是 bridge-descriptor 与独立应用 dsh-bridge 的事）。
 * 始终成立：读方永远不因文件缺失/损坏而失败，一律回落到「没有独立应用」。
 *
 * @module dsh-pet/src/host/plugin/app-presence
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 存活标记文件名：与 bridge-descriptor 的描述文件同在插件数据根。 */
export const APP_PRESENCE_FILE = 'standalone-running.json';

/** 标记格式版本。 */
export const APP_PRESENCE_VERSION = 1;

/** 心跳新鲜度上限：独立应用每 30s 刷一次，给三倍余量。 */
export const APP_PRESENCE_STALE_MS = 90_000;

export interface AppPresence {
  readonly version: typeof APP_PRESENCE_VERSION;
  readonly pid: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
}

export function appPresencePath(userRoot: string): string {
  return join(userRoot, APP_PRESENCE_FILE);
}

export function parseAppPresence(raw: unknown): AppPresence | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== APP_PRESENCE_VERSION) return undefined;
  const pid = obj.pid;
  const startedAt = obj.startedAt;
  const heartbeatAt = obj.heartbeatAt;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  if (typeof heartbeatAt !== 'number' || !Number.isFinite(heartbeatAt)) return undefined;
  return { version: APP_PRESENCE_VERSION, pid, startedAt, heartbeatAt };
}

export function readAppPresence(userRoot: string): AppPresence | undefined {
  try {
    return parseAppPresence(JSON.parse(readFileSync(appPresencePath(userRoot), 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * 写/刷新存活标记。startedAt 在同一 pid 上保持不变（重启后 pid 变，自然刷新）。
 */
export function writeAppPresence(
  userRoot: string,
  options: { pid?: number; now?: number } = {},
): AppPresence {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();
  const previous = readAppPresence(userRoot);
  const startedAt = previous?.pid === pid ? previous.startedAt : now;
  const presence: AppPresence = { version: APP_PRESENCE_VERSION, pid, startedAt, heartbeatAt: now };
  const file = appPresencePath(userRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(presence, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return presence;
}

/** 只清自己写的标记：另一个独立实例的心跳不能被退出中的进程删掉。 */
export function clearAppPresence(userRoot: string, pid: number = process.pid): void {
  const current = readAppPresence(userRoot);
  if (current === undefined || current.pid !== pid) return;
  try {
    rmSync(appPresencePath(userRoot), { force: true });
  } catch {
    // 退出路径上尽力而为；留下过期标记最多让 DSH 下次误判一次，pid 不活时会自愈。
  }
}

export function isAppPresenceFresh(
  presence: AppPresence,
  now: number = Date.now(),
  staleMs: number = APP_PRESENCE_STALE_MS,
): boolean {
  return now - presence.heartbeatAt <= staleMs;
}

/** pid 存活探测：signal 0 只做存在性检查。EPERM 说明进程在但没权限，也算活着。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string } | undefined)?.code === 'EPERM';
  }
}

export interface StandaloneRunningOptions {
  readonly now?: number;
  readonly staleMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

/**
 * 独立桌宠是否正在本机运行：pid 活着 且 心跳新鲜。任一不满足都算没在跑。
 */
export function isStandaloneAppRunning(
  userRoot: string,
  options: StandaloneRunningOptions = {},
): boolean {
  const presence = readAppPresence(userRoot);
  if (presence === undefined) return false;
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? APP_PRESENCE_STALE_MS;
  if (!isAppPresenceFresh(presence, now, staleMs)) return false;
  const alive = options.isProcessAlive ?? isProcessAlive;
  return alive(presence.pid);
}
