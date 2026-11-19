/**
 * money 形态：账户金额的已用百分比与气泡文案。
 *
 * 不同币种不能相加金额，但比例是无量纲的，所以不需要汇率——各币种按自己的基准算剩余比例后叠加。
 *
 * @module dsh-pet/src/shared/balance/handlers/money
 */

import type { BalanceBubbleRow, BalanceView } from '../types.ts';
import type { ShapeHandler } from './shape.ts';

/**
 * 各币种按自己的基准算剩余比例，相加后折算成已用百分比。
 *
 * 没有基准的币种跳过，不替它猜一个；一个带基准的币种都没有则返回 undefined，不播档位动画。
 */
function moneyPercent(v: BalanceView): number | undefined {
  let remaining = 0;
  let based = 0;
  for (const w of v.wallets ?? []) {
    const total = Number(w.total);
    const full = Number(w.fullBalance);
    if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
    remaining += total / full; // 负数（透支）会拉低剩余量，最终被夹到「已用完」
    based++;
  }
  if (based === 0) return undefined;
  return Math.max(0, Math.min(100, 100 - remaining * 100));
}

/**
 * 一行「余额（峰/谷）¥x.xx」。
 *
 * 只显示 total 非 0 的币种：负数要显示（透支是真的欠钱），正好 0 的不占地方；CNY 优先，
 * 用符号拼接、以「/」分隔；全为 0 时兜底 ¥0.00，否则气泡会空一行。档位装饰只有提供该计价
 * 规则的服务商才有，没有就不加括号那一段。
 */
function moneyRows(v: BalanceView): BalanceBubbleRow[] {
  const visible = (v.wallets ?? [])
    .filter((w) => Number(w.total) !== 0)
    .sort((a, b) => (a.currency === 'CNY' ? 0 : 1) - (b.currency === 'CNY' ? 0 : 1));
  const amount =
    visible.length > 0 ? visible.map((w) => (w.currency === 'USD' ? '$' : '¥') + w.total).join('/') : '¥0.00';
  const rows: BalanceBubbleRow[] =
    !v.tier
      ? [{ role: 'label', text: '余额 ' + amount }]
      : [
          { role: 'label', text: '余额（' },
          { role: 'tier', tier: v.tier, text: v.tier === 'peak' ? '峰' : '谷' },
          { role: 'label', text: '）' + amount },
        ];
  if (v.todaySpend !== undefined) rows.push({ role: 'sub', text: '今日已用 ¥' + v.todaySpend.toFixed(2) });
  return rows;
}

/**
 * money 形态的展开页：按币种把钱包拆开，给出已用/满额与充值、赠送。
 *
 * 收起态只报一个合计金额，看不出「还剩多少额度」；这里补上满额与拆分，让「窗口明细」那一页在
 * 纯账户余额（DeepSeek 官方 key）场景下也有可读内容，而不是和收起态一模一样。
 */
function moneyDetailRows(v: BalanceView): BalanceBubbleRow[] {
  const wallets = (v.wallets ?? []).filter(
    (w) => Number(w.total) !== 0 || Number(w.fullBalance ?? 0) > 0,
  );
  if (wallets.length === 0) return moneyRows(v);
  const rows: BalanceBubbleRow[] = [];
  for (const w of wallets) {
    const symbol = w.currency === 'USD' ? '$' : '¥';
    rows.push({ role: 'label', text: w.currency + ' ' + symbol + w.total });
    // 满额只在「确实还没花到上限之外」时有意义：账户里有充值余额时 fullBalance 只是赠送额度，摆出来反而误导。
    if (w.fullBalance !== undefined && Number(w.fullBalance) >= Number(w.total)) {
      rows.push({ role: 'sub', text: '满额 ' + symbol + w.fullBalance });
    }
    const parts: string[] = [];
    if (Number(w.toppedUp) !== 0) parts.push('充值 ' + symbol + w.toppedUp);
    if (Number(w.granted) !== 0) parts.push('赠送 ' + symbol + w.granted);
    if (parts.length > 0) rows.push({ role: 'sub', text: parts.join(' · ') });
  }
  if (v.todaySpend !== undefined) {
    rows.push({ role: 'sub', text: '今日已用 ¥' + v.todaySpend.toFixed(2) });
  }
  return rows;
}

/** money 形态的展示规则：百分比按币种基准折算，收成一行业务气泡。 */
export const moneyHandler: ShapeHandler = {
  percent: moneyPercent,
  rows: moneyRows,
  detail: moneyDetailRows,
};
