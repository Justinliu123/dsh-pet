/**
 * 账户花费推导：用两次余额观测的差额累计「今日已用」。
 *
 * 不实现余额取数（归 ./balance），也不负责展示（归 src/shared/balance）：它只吃
 * queryBalance 的成功结果，维护一份按北京日期切分的当日消费与上次观测到的余额。
 *
 * 口径：余额**下降**记为消费；余额**上升**（充值/赠金）只更新基准、不计入消费；
 * 只统计 CNY 钱包（其它币种没有汇率源，混加会把账算错）。跨天自动清零。
 *
 * 始终成立：读盘失败按空账本继续（记账是增强，不能拖垮余额刷新）；写盘串行、原子替换。
 *
 * @module dsh-pet/src/host/spend
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BalanceResult } from './balance/types.ts';
import type { LoggerLike } from './log-file.ts';

/** 落盘文件名：与待办、日志同放在插件用户数据目录。 */
export const SPEND_FILE_NAME = 'spend.json';

/** 账本文件形状；version 便于将来迁移。 */
interface SpendFile {
  version: 1;
  /** 北京时间日期 YYYY-MM-DD；与当前日期不同即视为新的一天。 */
  date: string;
  /** 当日累计消费（人民币）。 */
  spentToday: number;
  /** 上次观测到的各币种余额（字符串，保留接口精度）。 */
  lastTotal: Record<string, string>;
  /** 最后更新时间（ms）。 */
  updatedAt: number;
}

/** 花费追踪器：余额刷新时喂观察结果，气泡组装时取当日累计。 */
export interface SpendTracker {
  /**
   * 观察一次余额结果：只认成功结果里的钱包；余额下降累计为消费。
   * @param result - queryBalance 的结果（失败结果直接忽略）
   */
  observe(result: BalanceResult): void;
  /** 当日累计消费（人民币）；跨天后立即读为 0。 */
  todaySpend(): number;
  /** 是否已经有过至少一次余额观测（没有观测就不显示「今日已用」，避免 0.00 误导）。 */
  hasObservation(): boolean;
  /** 等待落盘队列清空（测试/退出时用）。 */
  flush(): Promise<void>;
}

/** 构造入参。 */
export interface SpendTrackerOptions {
  /** 插件用户数据目录。 */
  userRoot: string;
  /** 读写失败告警出口。 */
  log: LoggerLike;
  /** 时间源；测试注入固定时钟。 */
  now?: () => number;
}

/** 北京时间日期键（宿主可能在任何时区跑，统一按 UTC+8 切天）。 */
function beijingDateKey(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 解析磁盘上的账本；形状不对或版本不符返回 null（按空账本继续）。 */
function parseSpendFile(raw: unknown): SpendFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (f.version !== 1) return null;
  if (typeof f.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return null;
  const spent = Number(f.spentToday);
  if (!Number.isFinite(spent) || spent < 0) return null;
  const lastTotal: Record<string, string> = {};
  if (f.lastTotal && typeof f.lastTotal === 'object' && !Array.isArray(f.lastTotal)) {
    for (const [currency, amount] of Object.entries(f.lastTotal as Record<string, unknown>)) {
      if (typeof amount === 'string') lastTotal[currency] = amount;
    }
  }
  return { version: 1, date: f.date, spentToday: spent, lastTotal, updatedAt: Number(f.updatedAt) || 0 };
}

/**
 * 创建花费追踪器（进程内一份）。
 * @param options - 数据目录、日志与时间源
 * @returns 追踪器；首次读盘失败时按空账本继续
 */
export function createSpendTracker(options: SpendTrackerOptions): SpendTracker {
  const { userRoot, log } = options;
  const now = options.now ?? (() => Date.now());
  const file = join(userRoot, SPEND_FILE_NAME);
  let state: SpendFile = {
    version: 1,
    date: beijingDateKey(now()),
    spentToday: 0,
    lastTotal: {},
    updatedAt: now(),
  };
  let queue: Promise<void> = Promise.resolve();
  let observed = false;

  // 启动时同步读一次：读不到就按空账本（首日从第一次观测开始累计）。
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const parsed = parseSpendFile(raw);
    if (parsed) state = parsed;
  } catch {
    // 文件不存在或损坏：按新账本继续，不阻塞启动
  }

  /** 串行落盘：先写临时文件再改名，避免读到写了一半的状态。 */
  const persist = (): void => {
    const snapshot: SpendFile = { ...state, lastTotal: { ...state.lastTotal }, updatedAt: now() };
    queue = queue
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
        await rename(tmp, file);
      })
      .catch((error: unknown) => {
        log.warn?.('[dsh-pet] 花费账本写入失败：' + (error instanceof Error ? error.message : String(error)));
      });
  };

  const walletsOf = (result: BalanceResult): readonly { currency: string; total: string }[] => {
    if (!result.ok) return [];
    if (result.shape === 'money') return result.data.wallets;
    if (result.shape === 'windows') return result.data.account?.wallets ?? [];
    return [];
  };

  return {
    observe(result) {
      const wallets = walletsOf(result);
      if (wallets.length === 0) return;
      const today = beijingDateKey(now());
      if (state.date !== today) {
        state.date = today;
        state.spentToday = 0;
      }
      let changed = false;
      for (const wallet of wallets) {
        if (wallet.currency !== 'CNY') continue;
        const total = Number(wallet.total);
        if (!Number.isFinite(total)) continue;
        const prevRaw = state.lastTotal.CNY;
        const prev = prevRaw === undefined ? undefined : Number(prevRaw);
        // 余额下降 = 消费；上升 = 充值，只更新基准
        // 用微元粒度收敛，避免浮点尾数（0.6000000000000005）落盘后越来越脏
        if (prev !== undefined && total < prev) {
          state.spentToday = Math.round((state.spentToday + prev - total) * 1e6) / 1e6;
        }
        state.lastTotal.CNY = String(total);
        observed = true;
        changed = true;
      }
      if (changed) persist();
    },
    todaySpend() {
      if (state.date !== beijingDateKey(now())) return 0;
      return Math.round(state.spentToday * 100) / 100;
    },
    hasObservation() {
      return observed || Object.keys(state.lastTotal).length > 0;
    },
    flush() {
      return queue;
    },
  };
}
