/**
 * 系统通知转述循环：把系统通知变成她自己的话（写 `say` 叶子）。
 *
 * 两路来源，同一个出口：
 * ① Windows 通知库里的第三方应用通知（见 ./windows.ts）——她主动去读；
 * ② DSH 会话事件（经 DSH 桥镜像进 `sections.notify` 的通知帧）——DSH 那边的事也由她说。
 *
 * 出口与待办提醒同构：挑一只承担者，写 `pets.<id>.say` 叶子，由现有说话通道（气泡 + 语音）消费。
 * 不负责渲染、不负责语音合成。
 *
 * 只在独立版里跑（宿主半侧的数据通道模式不注册它）：DSH 侧插件只当数据通道，
 * 文案与语音归独立版所有，否则两边各生成一份、语音各念一遍。
 * @module dsh-pet/src/host/system-notify/loop
 */
import { displayCovers } from '../surface.ts';
import { dshFrameToNotification } from './dsh-events.ts';
import { isDshSource, notificationSpeech, shouldRelay, type SystemNotification } from './notify-text.ts';
import type { WindowsNotificationReader, WindowsSystemNotification } from './windows.ts';
import { openWindowsNotifications } from './windows.ts';
import type { HostContext } from '../plugin/context.ts';

/** 轮询间隔（毫秒）：Windows 通知库的写入没有事件通知，只能轮询。 */
export const POLL_INTERVAL_MS = 3000;

/** 气泡停留时长（毫秒）：比默认 10 秒久一点，系统通知值得多看两眼。 */
export const BUBBLE_DURATION_MS = 15000;

/** 待转述队列上限（条）：攒太多就丢最旧的——她念的是「刚发生的」，积压的历史没有意义。 */
export const MAX_PENDING = 20;

/** 转述发生在桌面上：她住在桌面窗口里，网页端只是数据源。 */
export const RELAY_SURFACE = 'desktop';

/** 承担这次转述的宠物。 */
export interface RelaySpeaker {
  /** 宠物 id。 */
  readonly petId: string;
  /** 语音发给哪一端（桌面上那只会念）。 */
  readonly voiceTo: typeof RELAY_SURFACE;
}

/**
 * 挑一只承担这次转述的宠物：要在桌面上、没被第三方占用、没睡着。
 *
 * 与待办提醒的挑人规则同族（见 ../plugin/todo-reminders.ts），但判据多一条「在桌面上」——
 * 网页端没有桌宠，硬念给一个不存在的消费方等于白说。
 */
export function pickSpeaker(
  pets: readonly Record<string, unknown>[],
  isLocked: (petId: string) => boolean,
  isSleeping: (petId: string) => boolean = () => false,
): RelaySpeaker | null {
  for (const pet of pets) {
    const petId = String(pet.id ?? '');
    if (petId === '') continue;
    if (!displayCovers(RELAY_SURFACE, String(pet.display ?? ''))) continue;
    if (isLocked(petId)) continue;
    if (isSleeping(petId)) continue;
    return { petId, voiceTo: RELAY_SURFACE };
  }
  return null;
}

/** 转述循环的跨拍状态（水位线与待转述队列）。 */
export interface RelayState {
  /** Windows 通知水位线：已读到的最大 toast Id。 */
  afterId: number;
  /** 已读过的 DSH 通知段 counter。 */
  notifyCounter: number;
  /** 待转述队列（先到先说）。 */
  pending: SystemNotification[];
  /** Windows 侧是否已校准过（存量通知不算新通知）。 */
  primedWindows: boolean;
  /** DSH 侧是否已校准过。 */
  primedNotify: boolean;
}

/** 新建一份转述状态（初始未校准）。 */
export function createRelayState(): RelayState {
  return { afterId: 0, notifyCounter: 0, pending: [], primedWindows: false, primedNotify: false };
}

/** 一拍要用的能力（测试可注入替身）。 */
export interface SystemNotifyTickDeps {
  /** 当前生效的宠物列表（成品配置拍平）。 */
  effectivePetList: () => Record<string, unknown>[];
  /** 占用锁：被第三方占用的宠物这一拍不打扰。 */
  isLocked: (petId: string) => boolean;
  /** 睡着的宠物不打扰：睡着时说了它也听不见。 */
  isSleeping: (petId: string) => boolean;
  /** 写说话叶子。 */
  writeSay: (petId: string, text: string, durationMs: number, voiceTo: typeof RELAY_SURFACE) => void;
  /** 读 DSH 通知段（桥镜像进来的会话事件帧）：counter 与帧内容。 */
  readNotifyFrame: () => { counter: number; data: unknown } | null;
  /** 开关：关着就什么都不做（连通知库都不开）。 */
  isEnabled: () => boolean;
  /** Windows 通知读取器；缺省表示该平台不支持。 */
  reader?: WindowsNotificationReader;
  /** 日志出口。 */
  log: { info: (message: string) => void; warn: (message: string) => void };
}

/**
 * 跑一拍：读新通知 → 入队 → 念一条。
 *
 * 一拍只念一条：说话叶子是单槽，同一拍写两条后一条会把前一条顶掉。
 * 念不出去的（没有能说话的宠物）留在队列里等下一拍，通知不会丢。
 *
 * @param deps - 一拍所需的能力。
 * @param state - 跨拍状态（水位线与队列），由调用方持有。
 * @returns 本拍念出去的通知条数。
 */
export function tickSystemNotifications(deps: SystemNotifyTickDeps, state: RelayState): number {
  if (!deps.isEnabled()) {
    // 开关关着：不读通知库、不看通知段。顺带把校准标记清掉——
    // 下次打开时重新校准，免得把关着这段时间攒下的旧通知一口气念出来。
    state.primedWindows = false;
    state.primedNotify = false;
    return 0;
  }
  collectDshFrames(deps, state);
  collectSystemNotifications(deps, state);
  return speakOne(deps, state);
}

/** DSH 会话事件帧 → 队列（段是单槽，counter 变了就是新的一帧）。 */
function collectDshFrames(deps: SystemNotifyTickDeps, state: RelayState): void {
  const frame = deps.readNotifyFrame();
  if (frame === null) return;
  if (!state.primedNotify) {
    // 首次校准：这一段里已有的内容是「我开始之前就有的」，不当新事件。
    state.notifyCounter = frame.counter;
    state.primedNotify = true;
    return;
  }
  if (frame.counter === state.notifyCounter) return;
  state.notifyCounter = frame.counter;
  const notification = dshFrameToNotification(frame.data);
  if (notification === null) return;
  enqueue(state, notification);
}

/** Windows 通知库里的新增 toast → 队列。 */
function collectSystemNotifications(deps: SystemNotifyTickDeps, state: RelayState): void {
  const reader = deps.reader;
  if (reader === undefined) return;
  if (!state.primedWindows) {
    // 首次校准：库里已有的通知是「我开始之前就有的」，不当新通知——
    // 否则刚开开关就把历史通知一口气念一遍。
    state.afterId = reader.maxToastId(state.afterId);
    state.primedWindows = true;
    return;
  }
  let batch: WindowsSystemNotification[];
  try {
    batch = reader.readSince(state.afterId);
  } catch (error) {
    deps.log.warn('[dsh-pet] 系统通知读取失败：' + (error instanceof Error ? error.message : String(error)));
    return; // 不推进水位线：下一拍重读，不会漏
  }
  for (const notification of batch) {
    state.afterId = Math.max(state.afterId, notification.id);
    // DSH 自己的通知不转述：同一件事说两遍没必要。
    if (isDshSource(notification.appId)) continue;
    if (!shouldRelay(notification)) continue;
    enqueue(state, notification);
  }
}

/** 从队列里取一条念出来；没有能说话的宠物就留着，下一拍再说。 */
function speakOne(deps: SystemNotifyTickDeps, state: RelayState): number {
  const speaker = pickSpeaker(deps.effectivePetList(), deps.isLocked, deps.isSleeping);
  if (speaker === null) return 0;
  const notification = state.pending.shift();
  if (notification === undefined) return 0;
  const speech = notificationSpeech(notification);
  if (speech === '') return 0;
  deps.writeSay(speaker.petId, speech, BUBBLE_DURATION_MS, speaker.voiceTo);
  // 只记来源与宠物，不记通知正文——正文是用户内容，不进日志
  deps.log.info(`[dsh-pet] 系统通知转述 app=${notification.appId} pet=${speaker.petId}`);
  return 1;
}

/** 入队；超出上限就丢最旧的。 */
function enqueue(state: RelayState, notification: SystemNotification): void {
  state.pending.push(notification);
  if (state.pending.length > MAX_PENDING) state.pending.splice(0, state.pending.length - MAX_PENDING);
}

/** 开关的读盘缓存时长（毫秒）：配置读盘有成本，十秒读一次足够。 */
const ENABLED_CACHE_MS = 10_000;

/** 循环的启动形态：与待办提醒一致，用 ctx.effect 挂起。 */
export interface SystemNotifyLoopDeps extends SystemNotifyTickDeps {
  /** 宿主上下文（挂定时器、收清理函数）。 */
  ctx: HostContext;
  /** 时间源；测试注入固定时钟。 */
  now?: () => number;
}

/**
 * 注册系统通知转述循环；返回的清理函数由 ctx.effect 收集。
 *
 * 水位线在闭包里维护：只在成功读到新通知后推进，读失败不推进（下一拍重试，不会漏）。
 *
 * @param deps - 循环所需的能力。
 */
export function registerSystemNotify(deps: SystemNotifyLoopDeps): void {
  const state = createRelayState();
  let reader = deps.reader;
  let enabledAt = 0;
  let enabledValue = false;

  /** 带缓存的开关读取：配置每次都读盘太勤，十秒一次足够。 */
  const readEnabled = (): boolean => {
    const now = deps.now?.() ?? Date.now();
    if (now - enabledAt < ENABLED_CACHE_MS) return enabledValue;
    enabledValue = deps.isEnabled();
    enabledAt = now;
    return enabledValue;
  };

  deps.ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = (): void => {
      if (disposed) return;
      try {
        // 只有开了开关、且平台真有这个库时才打开：读用户的通知库是隐私面，默认不碰。
        if (reader === undefined && readEnabled() && process.platform === 'win32') {
          reader = openWindowsNotifications();
        }
        tickSystemNotifications({ ...deps, isEnabled: readEnabled, reader }, state);
      } catch (error) {
        deps.log.warn('[dsh-pet] 系统通知转述失败：' + (error instanceof Error ? error.message : String(error)));
      }
      timer = setTimeout(run, POLL_INTERVAL_MS);
    };

    void run();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      reader?.close();
      reader = undefined;
    };
  }, 'dsh-pet: system notifications');
}
