/**
 * 气泡行数据的主出口：把余额状态转成气泡行，浏览器与桌面共用同一份内容与文案。
 *
 * 纯函数，不碰 DOM 与 React；形态相关的文案也不在这里，本模块只负责不可用状态的说明行，
 * 其余按形态查分发表。必须始终成立：不可用时绝不伪造数字。
 *
 * @module dsh-pet/src/shared/balance/view
 */

import { HANDLERS } from './handlers/index.ts';
import { pricingRows } from './pricing.ts';
import type { BalanceBubbleRow, BalanceState, BalanceUnavailable, CustomNode } from './types.ts';

/**
 * 不可用状态的气泡行：显式给出原因，绝不伪造数字。
 *
 * 次要行为空的会被剔除——空 div 在气泡里会白占一行高度。
 */
function unavailableRows(state: BalanceUnavailable): BalanceBubbleRow[] {
  const rows: BalanceBubbleRow[] =
    state.reason === 'unsupported'
      ? [
          { role: 'error', text: '当前服务商暂不支持余额查询' },
          {
            role: 'sub',
            // 自定义服务商没有余额接口：直接告诉用户换成哪家，而不是只报一个 id。
            text:
              state.provider === 'custom'
                ? '当前服务商：custom（AI 设置里选 DeepSeek 或 MiniMax 即可查余额；DSH 开着时也会自动同步）'
                : '当前服务商：' + state.provider,
          },
        ]
      : state.reason === 'credential-missing'
        ? [
            // host 的 message 已自带「缺少凭证 X」前缀，这里原样展示，不再加前缀。
            { role: 'error', text: '缺少余额查询凭证' },
            { role: 'sub', text: state.message ?? '' },
          ]
        : [
            { role: 'error', text: '余额查询失败' },
            { role: 'sub', text: state.message ?? '' },
          ];
  return rows.filter((r) => r.role !== 'quota' && r.text !== '');
}

/**
 * 把余额状态渲染成气泡行数据。
 *
 * 形态文案由各 handler 提供；custom 形态返回空数组——它走节点树这条并行通道（见下方 customViews），
 * 空数组只在误用行数据时兜底成空气泡。不可用时显式展示原因，绝不伪造数字。
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  return HANDLERS[state.shape].rows(state);
}

/**
 * 展开态的气泡行，点开余额气泡后显示。
 *
 * 只有 windows 有三窗口读数可展开，每个存在的窗口一行；money 与 points 没有窗口概念，
 * 回落到收起态视图，避免点了一下却什么都没变的空交互。
 */
export function balanceDetailView(state: BalanceState): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  const handler = HANDLERS[state.shape];
  return handler.detail ? handler.detail(state) : handler.rows(state);
}

/**
 * 余额气泡是否带峰谷价目页。
 *
 * 只有「窗口额度 + DeepSeek 账户余额」的组合视图才有意义：组合视图说明服务商是 DeepSeek
 * （峰谷定价只属于它），纯窗口视图（MiniMax、OpenCode Go 等）不该看到 DeepSeek 的价目。
 */
export function pricingPageAvailable(state: BalanceState): boolean {
  if (!state.ok || state.shape !== 'windows') return false;
  return (state.accountWallets?.length ?? 0) > 0;
}

/** 点击编排里可关掉的页（设置页「气泡」分区写的就是它）。
 *  关闭只是不放进翻页序列，收起态（第一页）永远保留；custom 形态各页对等，不受这里影响。 */
export interface BubblePageOptions {
  /** 是否保留「窗口明细」页（含区间用量页）。缺键按 true。 */
  readonly detail?: boolean;
  /** 是否保留「峰谷价目」页。缺键按 true。 */
  readonly pricing?: boolean;
}

/** windows 形态按编排选项算出来的页序列：第 0 页永远是收起态。
 *  明细与用量是一体的（用量页挂在明细后面），关掉明细时用量也一起去掉，避免翻页跳空。 */
function windowPageKinds(state: BalanceState, options: BubblePageOptions): Array<'summary' | 'detail' | 'usage' | 'pricing'> {
  const kinds: Array<'summary' | 'detail' | 'usage' | 'pricing'> = ['summary'];
  if (options.detail !== false) {
    kinds.push('detail');
    if (state.ok && state.usage) kinds.push('usage');
  }
  if (options.pricing !== false && pricingPageAvailable(state)) kinds.push('pricing');
  return kinds;
}

/**
 * 余额气泡的可翻页数：不可用只有一页说明；windows 按编排选项（默认收起态 + 明细 + 峰谷），
 * custom 以节点树页数为准，其余形态点开没有新内容。
 *
 * 页数与 {@link balancePageView} 必须同源：两边各判一次就会翻出一页空白。
 */
export function balancePageCount(state: BalanceState, options: BubblePageOptions = {}): number {
  if (!state.ok) return 1;
  if (state.shape === 'custom') return Math.max(1, customViews(state)?.length ?? 1);
  if (state.shape !== 'windows') return 1;
  return windowPageKinds(state, options).length;
}

/**
 * 指定页的气泡行数据：按编排选项取对应页；越界页回落到最后一页有内容的页，
 * 不返回空数组——空白气泡比停在前一页更像坏了。
 */
export function balancePageView(state: BalanceState, page: number, options: BubblePageOptions = {}): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  const handler = HANDLERS[state.shape];
  if (state.shape !== 'windows' || page <= 0) return handler.rows(state);
  const kinds = windowPageKinds(state, options);
  // 越界就停在最后一页（末页再点是收起的语义在调用方，这里只保证有内容）。
  const kind = kinds[Math.min(Math.max(page, 0), kinds.length - 1)];
  if (kind === 'pricing') return pricingRows();
  if (kind === 'detail') return balanceDetailView(state);
  if (kind === 'usage') return handler.usage?.(state) ?? balanceDetailView(state);
  return handler.rows(state);
}

// 自定义气泡（custom 形态）走节点树这条并行通道：行数据由插件定好长什么样，只填文案；
// 节点树把布局本身交给第三方。两种通道按 shape 互斥，两端渲染入口各判一次即可，其余展示逻辑共用。

/**
 * 多页节点树：只对 custom 形态有值，其余形态返回 undefined，调用方据此回落行数据。
 * 第一项是初始页；多于一项时气泡可点，点一下切下一页，末页回第一页。
 */
export function customViews(state: BalanceState): CustomNode[] | undefined {
  if (!state.ok || state.shape !== 'custom') return undefined;
  const views = HANDLERS[state.shape].views?.(state);
  return views && views.length > 0 ? views : undefined;
}

/**
 * custom 气泡是否可点切页，两端据此决定气泡可不可点。
 *
 * 只有一页时点开也没有别的内容，保持不可点，气泡继续不挡页面。
 */
export function customClickable(state: BalanceState): boolean {
  return (customViews(state)?.length ?? 0) > 1;
}
