/**
 * 独立桌宠侧的心跳：定期刷新 ~/.dsh/dsh-pet/standalone-running.json，让 DSH 宿主知道别拉第二套窗口。
 *
 * 为什么放在独立侧：只有正在渲染桌宠的进程知道自己是谁、什么时候退出；DSH 侧只能靠文件判断。
 * 频率 30s：宿主侧的新鲜度窗口是 90s，三倍余量足以覆盖一次 GC/暂停，又不会让文件写得太勤。
 * 不负责：桥接（dsh-bridge 自己会读 DSH 描述文件，两边互不依赖）。
 * 始终成立：写失败只记日志，绝不让桌宠因此退出——标记只是「别开第二只」的优化。
 *
 * @module dsh-pet/src/standalone/presence
 */
import { clearAppPresence, writeAppPresence } from '../host/plugin/app-presence.ts';

/** 心跳间隔：宿主侧判活窗口 APP_PRESENCE_STALE_MS 的三分之一。 */
export const APP_PRESENCE_INTERVAL_MS = 30_000;

export interface AppPresenceHandle {
  /** 停心跳并清掉自己写的标记（退出路径调用）。 */
  stop(): void;
}

export interface AppPresenceOptions {
  readonly intervalMs?: number;
  /** 只记关键事件：首写成功与写失败，不刷屏。 */
  readonly log?: (message: string) => void;
}

/**
 * 启动心跳：立即写一次（DSH 可能马上要 apply），之后按间隔刷新。
 */
export function startAppPresence(userRoot: string, options: AppPresenceOptions = {}): AppPresenceHandle {
  const intervalMs = options.intervalMs ?? APP_PRESENCE_INTERVAL_MS;
  let stopped = false;

  const write = (): void => {
    if (stopped) return;
    try {
      writeAppPresence(userRoot);
    } catch (error) {
      options.log?.(`写独立桌宠存活标记失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  write();
  options.log?.(`独立桌宠存活标记已写入：${userRoot}（DSH 侧据此只当数据源，不再开第二只宠物）`);
  const timer = setInterval(write, intervalMs);
  // 心跳不该把进程钉住：真正的退出由窗口/托盘/信号决定。
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearAppPresence(userRoot);
    },
  };
}
