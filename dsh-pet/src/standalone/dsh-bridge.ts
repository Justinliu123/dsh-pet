/**
 * DSH 桥（独立桌宠侧）：DSH 宿主在跑时，把它的余额 / 工作状态 / 通知 / 宠物说话镜像进本地快照。
 *
 * 为什么是「读描述文件 + 拉 /state」而不是直连固定端口：DSH 的 Web 端口每次启动随机（port=0），
 * 扫端口不可靠；DSH 侧宿主把入口写进 ~/.dsh/dsh-pet/standalone-bridge.json，本端每秒读一次即可。
 * 桥只做镜像，不反向写 DSH：独立应用是数据消费者，反向写入会和 DSH 里的设置页打架。
 * DSH 不在时桥静默断开（不报错、不弹窗），独立功能照常；余额/通知这类历史事实保持断链前的样子，
 * 只有工作状态会被重置为空闲——它描述的是「现在在做什么」，留着会永远显示「思考中」。
 * 去重规则：指令类（说/演）只在远端 counter 变化时写；事实类除 counter 变化外，本地内容与远端不同也重写，
 * 否则本地自己的余额轮询会用 unsupported 覆盖掉 DSH 给的余额。
 * 始终成立：读本地状态与写本地状态都只经宿主半侧的 PollStateStore，不绕过 counter。
 *
 * @module dsh-pet/src/standalone/dsh-bridge
 */
import { dirname } from 'node:path';
import { readBridgeDescriptor } from '../host/plugin/bridge-descriptor.ts';
import { createDshEndpointResolver } from './dsh-endpoint.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';

/** 会被镜像的全局段：config/menu/focusSession 不镜像——前两者是 DSH 侧 UI 的形态，
 *  focusSession 是「跳到哪个会话」的一次性指令，独立应用没有 DSH 会话可跳。 */
export type MirroredSectionName = 'balance' | 'workStatus' | 'notify' | 'env';

/** 会被镜像的每宠物叶子：说与演是指令，position/throw 是物理状态、位置只有本机窗口知道。 */
export type MirroredPetLeafName = 'say' | 'anim';

export const MIRRORED_SECTIONS: readonly MirroredSectionName[] = ['balance', 'workStatus', 'notify', 'env'];
export const MIRRORED_PET_LEAVES: readonly MirroredPetLeafName[] = ['say', 'anim'];

/** 轮询间隔：与 DSH 页面一致按 1s；/state 是本机回环，开销可忽略。 */
export const MIRROR_INTERVAL_MS = 1000;

/** 单次请求上限：卡住的宿主不能把桥拖成一串堆积的请求。 */
export const MIRROR_REQUEST_TIMEOUT_MS = 1500;

/** 连续失败几次判定断开：一次抖动（宿主重启）不写日志、不重置工作状态。 */
export const MIRROR_MAX_FAILURES = 3;

/** 断链后写回的工作状态：形状与 work-status-bridge 一致（state=null 即空闲）。 */
export const IDLE_WORK_STATUS = { state: null, task: null, sessionId: null } as const;

interface RemoteLeaf {
  readonly counter?: number;
  readonly data?: unknown;
}

/** 远端 /state 的最小形状（比宿主 PollState 宽松：只关心这里会用到的字段）。 */
export interface RemoteStateSnapshot {
  readonly counter?: number;
  readonly sections?: Record<string, RemoteLeaf | undefined>;
  readonly pets?: Record<string, Record<string, RemoteLeaf | undefined> | undefined>;
}

/** 本地状态仓的读取面（宿主半侧 PollStateStore 结构上满足它）。 */
export interface BridgeLocalSnapshot {
  readonly sections: Record<string, { counter: number; data: unknown }>;
  readonly pets: Record<string, Record<string, { counter: number; data: unknown }>>;
}

/** 桥对本地状态仓的要求：只读快照 + 两个写入口。 */
export interface BridgeStateStore {
  read(): BridgeLocalSnapshot;
  writeSection(name: MirroredSectionName, data: unknown): void;
  writePet(petId: string, leaf: MirroredPetLeafName, data: unknown): unknown;
}

export type MirrorWrite =
  | { readonly kind: 'section'; readonly name: MirroredSectionName; readonly data: unknown }
  | { readonly kind: 'pet'; readonly petId: string; readonly leaf: MirroredPetLeafName; readonly data: unknown };

/** 已镜像的远端版本：段按名字记 counter，宠物叶子按 `petId\u0000leaf` 记 counter。 */
export interface MirrorSeen {
  sections: Record<string, number>;
  pets: Record<string, number>;
}

export function createMirrorSeen(): MirrorSeen {
  return { sections: {}, pets: {} };
}

/** 内容比较用的稳定串：undefined 与 null 必须区分（null = 还没数据，不是「空对象」）。 */
function sameContent(a: unknown, b: unknown): boolean {
  return (JSON.stringify(a) ?? 'undefined') === (JSON.stringify(b) ?? 'undefined');
}

function petKey(petId: string, leaf: MirroredPetLeafName): string {
  return `${petId}\u0000${leaf}`;
}

/**
 * 决定这一拍要往本地写什么（纯函数，便于单测）。
 *
 * 返回的 seen 是「写完之后」的版本号：调用方用它替换手里那份，下一拍才能正确去重。
 * 远端缺某个段/叶子时不做任何事（不写 null）——缺数据不等于「远端把数据清空了」。
 */
export function planMirror(input: {
  readonly remote: RemoteStateSnapshot | undefined;
  readonly seen: MirrorSeen;
  readonly localSections: Record<string, unknown>;
}): { writes: MirrorWrite[]; seen: MirrorSeen } {
  const writes: MirrorWrite[] = [];
  const seen: MirrorSeen = { sections: { ...input.seen.sections }, pets: { ...input.seen.pets } };
  if (input.remote === undefined) return { writes, seen };

  for (const name of MIRRORED_SECTIONS) {
    const leaf = input.remote.sections?.[name];
    if (leaf === undefined) continue;
    const counter = typeof leaf.counter === 'number' ? leaf.counter : 0;
    const advanced = seen.sections[name] !== counter;
    if (!advanced && sameContent(input.localSections[name], leaf.data)) continue;
    writes.push({ kind: 'section', name, data: leaf.data });
    seen.sections[name] = counter;
  }

  for (const [petId, leaves] of Object.entries(input.remote.pets ?? {})) {
    if (leaves === undefined) continue;
    for (const leafName of MIRRORED_PET_LEAVES) {
      const leaf = leaves[leafName];
      if (leaf === undefined) continue;
      const counter = typeof leaf.counter === 'number' ? leaf.counter : 0;
      const key = petKey(petId, leafName);
      if (seen.pets[key] === counter) continue;
      writes.push({ kind: 'pet', petId, leaf: leafName, data: leaf.data });
      seen.pets[key] = counter;
    }
  }
  return { writes, seen };
}

export interface DshBridgeStatus {
  readonly connected: boolean;
  readonly origin: string | null;
  readonly lastError: string | null;
  readonly mirroredAt: number | null;
}

export interface DshBridgeOptions {
  readonly state: BridgeStateStore;
  readonly userRoot: string;
  /**
   * DSH 数据根（`~/.dsh`），用来从 DSH 日志兜底发现入口；缺省取 userRoot 的上一级。
   * 描述文件是首选通道，日志只是「宿主侧还没公布」时的退路。
   */
  readonly dshHome?: string;
  readonly log: (message: string) => void;
  readonly intervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface DshBridge {
  start(): void;
  stop(): void;
  status(): DshBridgeStatus;
}

/**
 * 建桥（不自动启动）：start 前不会发任何请求，stop 后可安全重复调用。
 */
export function createDshBridge(options: DshBridgeOptions): DshBridge {
  const intervalMs = options.intervalMs ?? MIRROR_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const endpoint = createDshEndpointResolver({ dshHome: options.dshHome ?? dirname(options.userRoot) });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let consecutiveFailures = 0;
  let seen = createMirrorSeen();
  let seenOrigin: string | null = null;
  let connected = false;
  let lastError: string | null = null;
  let mirroredAt: number | null = null;

  const disconnect = (reason?: string): void => {
    if (reason !== undefined) lastError = reason;
    if (!connected) return;
    connected = false;
    seen = createMirrorSeen();
    seenOrigin = null;
    try {
      options.state.writeSection('workStatus', IDLE_WORK_STATUS);
    } catch {
      // 窗口还没建好时写状态可能失败：断链不是致命错误，独立功能照常。
    }
    options.log(`[dsh-pet] DSH 桥已断开${reason ? `（${reason}）` : ''}：独立功能照常运行`);
  };

  const tick = async (): Promise<void> => {
    const descriptor = readBridgeDescriptor(options.userRoot);
    // 首选描述文件；它缺席、或刚连续失败（可能是宿主重启留下的旧端口）时，用 DSH 日志里
    // 最后公布的入口兜底——旧版宿主半侧只公布一次，插件没重载就拿不到描述文件。
    const origin =
      descriptor !== undefined && consecutiveFailures === 0
        ? descriptor.origin
        : (endpoint.resolve() ?? descriptor?.origin);
    if (origin === undefined) {
      disconnect();
      return;
    }
    if (seenOrigin !== origin) {
      // 宿主重启/换端口：旧 counter 全部失效，重新完整镜像一遍。
      seen = createMirrorSeen();
      seenOrigin = origin;
    }
    const response = await fetchImpl(`${origin}${ROUTE_SEGMENT}/state`, {
      signal: AbortSignal.timeout(MIRROR_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET /state → HTTP ${response.status}`);
    const remote = (await response.json()) as RemoteStateSnapshot;
    const local = options.state.read();
    const localSections: Record<string, unknown> = {};
    for (const name of MIRRORED_SECTIONS) localSections[name] = local.sections[name]?.data;
    const plan = planMirror({ remote, seen, localSections });
    for (const write of plan.writes) {
      if (write.kind === 'section') options.state.writeSection(write.name, write.data);
      else options.state.writePet(write.petId, write.leaf, write.data);
    }
    seen = plan.seen;
    mirroredAt = now();
    consecutiveFailures = 0;
    lastError = null;
    if (!connected) {
      connected = true;
      options.log(
        `[dsh-pet] DSH 桥已连接：${origin}（余额/会话工作状态/通知/说话来自 DSH，独立功能照常）`,
      );
    }
  };

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await tick();
    } catch (error) {
      consecutiveFailures += 1;
      lastError = error instanceof Error ? error.message : String(error);
      // 拿到的入口不可用（宿主已退出/端口被别人占了）：丢掉日志缓存，下一拍重新读日志。
      endpoint.invalidate();
      if (consecutiveFailures >= MIRROR_MAX_FAILURES) disconnect(lastError);
    }
    if (stopped) return;
    timer = setTimeout(() => {
      void loop();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    start(): void {
      if (stopped || running !== undefined) return;
      running = loop();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      disconnect();
    },
    status(): DshBridgeStatus {
      return { connected, origin: seenOrigin, lastError, mirroredAt };
    },
  };
}

/**
 * 从宿主半侧（Cordis ctx 或独立模式的伪 ctx）取出轮询状态仓：
 * 宿主半侧的 apply() 会把 PollStateStore 挂成 petBridge7340 服务。
 * 取不到返回 undefined（旧版宿主半侧没有这个服务），只影响镜像，不影响独立功能。
 */
export function bridgeStateOfContext(ctx: unknown): BridgeStateStore | undefined {
  const get = (ctx as { get?: (name: string, required?: boolean) => unknown } | null | undefined)?.get;
  const service = typeof get === 'function' ? get.call(ctx, 'petBridge7340', false) : undefined;
  const state = (service as { state?: unknown } | undefined)?.state;
  return state === undefined ? undefined : (state as unknown as BridgeStateStore);
}
