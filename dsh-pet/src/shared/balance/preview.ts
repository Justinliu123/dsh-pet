/**
 * 设置页预览用的「这一页会长什么样」。
 *
 * 预览必须与桌宠同源：直接调用渲染用的 `resolveBubblePages` / `clickPageView`，
 * 用**真实**的余额状态算出每一页的行，而不是拿种子模板 + 样本数据糊一份——
 * 否则账户金额（money）形态下预览会凭空多出「周额度剩」，实际气泡却没有。
 * @module dsh-pet/src/shared/balance/preview
 */
import type { BalanceBubbleRow, BalanceState } from './types.ts';
import { clickPageView, resolveBubblePages } from './view.ts';

/** 能在预览里还原的预置页（whisper 只是文案；custom 由编辑器里的模板负责）。 */
export type PreviewKind = 'summary' | 'detail' | 'pricing';

/** 预置页的固定顺序。 */
export const PREVIEW_KINDS: readonly PreviewKind[] = ['summary', 'detail', 'pricing'];

/** 预置页 → 行；这一页当前不可用（例如没配 MiniMax 时的峰谷页）就不给键。 */
export type BubbleKindPreviews = Partial<Record<PreviewKind, BalanceBubbleRow[]>>;

/**
 * 用当前余额状态算出各预置页的行，供设置页预览直接显示。
 * @param state - 归一化后的余额状态（与桌面渲染同一份）。
 * @returns 可用的预置页行；不可用的页不出现。
 */
export function kindPreviews(state: BalanceState): BubbleKindPreviews {
  const out: BubbleKindPreviews = {};
  for (const kind of PREVIEW_KINDS) {
    const step = [{ kind }];
    if (resolveBubblePages(state, step, {}).length === 0) continue;
    out[kind] = clickPageView(state, 0, step, {});
  }
  return out;
}
