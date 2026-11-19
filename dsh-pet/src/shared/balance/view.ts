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
import { renderBubbleTemplate } from './template.ts';
import type {
  BalanceBubbleRow,
  BalanceState,
  BalanceUnavailable,
  BubbleClickStep,
  BubblePageKind,
  BubbleRowTemplate,
  CustomNode,
} from './types.ts';

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

/** 峰谷定价只属于 DeepSeek：账号态与官方 key 都算。 */
const DEEPSEEK_PROVIDER_IDS: ReadonlySet<string> = new Set(['deepseek-account', 'deepseek-official']);

/**
 * 余额气泡是否带峰谷价目页。
 *
 * 只有「窗口额度 + DeepSeek 账户余额」的组合视图才有意义：组合视图说明服务商是 DeepSeek
 * （峰谷定价只属于它），纯窗口视图（MiniMax、OpenCode Go 等）不该看到 DeepSeek 的价目。
 */
export function pricingPageAvailable(state: BalanceState): boolean {
  if (!state.ok) return false;
  if (state.shape === 'windows') return (state.accountWallets?.length ?? 0) > 0;
  // 只有账户金额（DeepSeek 官方 key）时也有峰谷：价目属于服务商，不是属于窗口形态。
  return state.shape === 'money' && DEEPSEEK_PROVIDER_IDS.has(state.provider);
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

/** 缺省编排：收起态（余额/额度/今日已用）→ 窗口明细 → 峰谷价目，与旧的两开关行为一致。 */
/** 点击编排实际翻到的页：队列里的步骤 + detail 展开出的 usage 页。 */
export type BubbleClickPage = BubblePageKind | 'usage';

export const DEFAULT_BUBBLE_CLICK_STEPS: readonly BubbleClickStep[] = [
  { kind: 'summary' },
  { kind: 'detail' },
  { kind: 'pricing' },
];

/** 点击编排解析出的一页：kind + 页标识 + 这一步的配置。 */
export interface ResolvedBubblePage {
  readonly kind: BubblePageKind;
  /** 页标识：自定义页按 id（没 id 就按序号），预置页按 kind。 */
  readonly key: string;
  /** 对应的队列步骤（页内容优先用 step.template）。 */
  readonly step: BubbleClickStep;
  /** detail 步骤在服务商给了区间用量时多出来的一页。 */
  readonly variant?: 'usage';
}

/** 这一页的标识：自定义页按 id 区分（没 id 就按序号，保证多份自定义页不互相顶掉）。 */
function bubbleStepKey(step: BubbleClickStep, index: number): string {
  if (step.kind === 'custom') {
    const id = typeof step.id === 'string' ? step.id.trim() : '';
    return id === '' ? 'custom@' + index : 'custom#' + id;
  }
  return step.kind;
}

/** 这一页用哪份模板：步骤自带模板优先；自定义页没带就回落旧的全局 bubbleTemplate。 */
function bubbleStepRows(
  step: BubbleClickStep,
  legacy?: readonly BubbleRowTemplate[],
): readonly BubbleRowTemplate[] | undefined {
  if (Array.isArray(step.template) && step.template.length > 0) return step.template;
  if (step.kind === 'custom' && Array.isArray(legacy) && legacy.length > 0) return legacy;
  return undefined;
}

/** 点击编排的最终页序列：按队列顺序过滤可用性，再兜底。
 *
 * 规则（与设置页「气泡 → 点击编排」一一对应）：
 * - enabled === false 的步骤跳过；同一页标识只保留第一次出现（重复不重复弹）。
 * - 自定义页可以放多份：靠步骤的 id 区分，各自带各的模板。
 * - 步骤自带模板的页按模板渲染（用户在设置页里把这一页改过了）；
 *   detail 带模板时不再拆出「用量」页——那一页已经是他自己定义的样子。
 * - detail 步骤在服务商给了区间用量时展开成「明细 + 用量」两页（页数/内容同源）。
 * - pricing 只在「组合视图」（有 DeepSeek 账户余额 + 窗口额度）时可用；
 *   whisper 页要有最近一条碎碎念文案，否则跳过（不弹空白页）。
 * - 旧配置的 detail/pricing 开关仍然生效（options），并在新队列优先时作为兜底。
 * - 全部被关掉时退回收起态一页，绝不让点击变成什么都没发生。
 */
export function resolveBubblePages(
  state: BalanceState,
  steps: readonly BubbleClickStep[] | undefined,
  options: BubblePageOptions = {},
  whisperText?: string | null,
  template?: readonly BubbleRowTemplate[],
): ResolvedBubblePage[] {
  const seen = new Set<string>();
  const pages: ResolvedBubblePage[] = [];
  // 传了队列（配置里存的 bubbleClickSteps）就按队列走，旧开关不参与；没传才用默认口径+两个旧开关。
  // 「没给队列」或「给的就是缺省队列」都算默认口径：这时旧的 detail/pricing 开关仍然生效。
  const legacyGates = steps === undefined || steps === DEFAULT_BUBBLE_CLICK_STEPS;
  const queue = steps ?? DEFAULT_BUBBLE_CLICK_STEPS;
  for (let index = 0; index < queue.length; index += 1) {
    const step = queue[index];
    if (step === null || typeof step !== 'object') continue;
    if (step.enabled === false) continue;
    const kind = step.kind;
    if (kind !== 'summary' && kind !== 'detail' && kind !== 'pricing' && kind !== 'whisper' && kind !== 'custom') continue;
    const key = bubbleStepKey(step, index);
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = bubbleStepRows(step, template);
    // 自定义页没有内容就不显示（没配就等于没这一步）。
    if (kind === 'custom' && (rows === undefined || rows.length === 0)) continue;
    // 明细/用量只有窗口形态有；money/points 这类内置单页形态点了也只该有一页。
    // 明细页：窗口形态给区间明细，账户金额形态给钱包拆分（handler 的 detail 回落）。
    // custom/points 没有可展开的读数，仍只有一页。
    if (kind === 'detail' && (!state.ok || state.shape === 'custom' || state.shape === 'points')) continue;
    // 账户金额形态要真有钱包数据才值得多一页（否则明细与收起态一模一样，白翻一次）。
    if (kind === 'detail' && state.ok && state.shape === 'money') {
      const wallets = 'wallets' in state ? state.wallets : undefined;
      if ((wallets?.length ?? 0) === 0) continue;
    }
    // 编排队列是唯一真相：用户在「气泡」分区里显式列了这一步，就按队列来；
    // 旧的两个开关（bubbleClickPages）只在不带队列的默认口径里生效，避免老配置把新队列吃掉。
    if (legacyGates) {
      if (kind === 'detail' && options.detail === false) continue;
      if (kind === 'pricing' && options.pricing === false) continue;
    }
    if (kind === 'pricing' && !pricingPageAvailable(state)) continue;
    if (kind === 'whisper' && (whisperText === undefined || whisperText === null || whisperText === '')) continue;
    pages.push({ kind, key, step });
    if (kind === 'detail' && state.ok && state.usage && rows === undefined) {
      pages.push({ kind, key: key + '#usage', step, variant: 'usage' });
    }
  }
  return pages;
}

/** 点击编排的页种类序列：与 {@link resolveBubblePages} 同源，只把页标识换回 kind。 */
export function clickPageKinds(
  state: BalanceState,
  steps: readonly BubbleClickStep[] | undefined,
  options: BubblePageOptions = {},
  whisperText?: string | null,
  template?: readonly BubbleRowTemplate[],
): BubbleClickPage[] {
  const pages = resolveBubblePages(state, steps, options, whisperText, template);
  if (pages.length === 0) return ['summary'];
  return pages.map((page) => (page.variant === 'usage' ? 'usage' : page.kind));
}

/** 点击编排的总页数（custom 形态仍按节点树页数，不受队列影响）。 */
export function clickPageCount(
  state: BalanceState,
  steps: readonly BubbleClickStep[] | undefined,
  options: BubblePageOptions = {},
  whisperText?: string | null,
  template?: readonly BubbleRowTemplate[],
): number {
  if (!state.ok) return 1;
  if (state.shape === 'custom') return Math.max(1, customViews(state)?.length ?? 1);
  return resolveBubblePages(state, steps, options, whisperText, template).length;
}

/**
 * 点击编排第 index 页的气泡行：越界停在最后一页；碎碎念页直接展示文案本身。
 *
 * 与 {@link clickPageCount} 同源（同一个 clickPageKinds），两端翻页不会出现空白页。
 */
export function clickPageView(
  state: BalanceState,
  index: number,
  steps: readonly BubbleClickStep[] | undefined,
  options: BubblePageOptions = {},
  whisperText?: string | null,
  template?: readonly BubbleRowTemplate[],
): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  if (state.shape === 'custom') {
    const views = customViews(state) ?? [];
    return views.length === 0 ? [] : [];
  }
  const pages = resolveBubblePages(state, steps, options, whisperText, template);
  const list: readonly ResolvedBubblePage[] =
    pages.length > 0 ? pages : [{ kind: 'summary', key: 'summary', step: { kind: 'summary' } }];
  const page = list[Math.min(Math.max(index, 0), list.length - 1)];
  const handler = HANDLERS[state.shape];
  // 这一页自带模板就按模板渲染（用户在设置页里把这一页改成了自己的内容）。
  const rows = bubbleStepRows(page.step, template);
  if (rows !== undefined && rows.length > 0) return renderBubbleTemplate(rows, state, whisperText);
  if (page.kind === 'custom') return renderBubbleTemplate(template, state, whisperText);
  if (page.kind === 'whisper') return [{ role: 'label', text: whisperText ?? '' }];
  if (page.kind === 'pricing') return pricingRows();
  if (page.kind === 'detail') {
    return page.variant === 'usage' ? handler.usage?.(state) ?? balanceDetailView(state) : balanceDetailView(state);
  }
  return handler.rows(state);
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
