/**
 * 自定义气泡页：文本模板 + `{token}` 占位符 → 气泡行。
 *
 * 只做纯计算，供客户端、桌面 Helper 与设置页预览共用同一套占位符与格式，
 * 避免三处各写一遍替换规则后显示不一致。颜色/字号/对齐由配置给出，校验在宿主侧。
 *
 * @module dsh-pet/src/shared/balance/template
 */
import type { BalanceState } from './types.ts';
import type { BalanceBubbleRow, BubblePageKind, BubbleRowStyle, BubbleRowTemplate } from './types.ts';
import { FLASH_PRICE, PRO_PRICE, countdownText, isPeakAt, nextSwitchAt } from './pricing.ts';

/** 占位符目录：设置页按这份清单渲染「插入占位符」，注释即用户看到的说明。 */
export const BUBBLE_PLACEHOLDERS: readonly { readonly token: string; readonly label: string }[] = [
  { token: 'balance', label: '账户余额' },
  { token: 'tier', label: '峰/谷（账户档位）' },
  { token: 'todaySpend', label: '今日已用' },
  { token: 'rolling', label: '5h 剩余百分比' },
  { token: 'rollingReset', label: '5h 重置倒计时' },
  { token: 'weekly', label: '周剩余百分比' },
  { token: 'weeklyReset', label: '周重置倒计时' },
  { token: 'peakStatus', label: '高峰/谷价状态' },
  { token: 'peakCountdown', label: '距峰谷切换倒计时' },
  { token: 'flashHit', label: 'Flash 命中单价' },
  { token: 'flashMiss', label: 'Flash 未命中单价' },
  { token: 'flashOut', label: 'Flash 输出单价' },
  { token: 'proHit', label: 'Pro 命中单价' },
  { token: 'proMiss', label: 'Pro 未命中单价' },
  { token: 'proOut', label: 'Pro 输出单价' },
  { token: 'whisper', label: '最近一条碎碎念' },
  { token: 'date', label: '日期（北京时间）' },
  { token: 'time', label: '时间（北京时间）' },
];

/** 渲染上下文：所有占位符的最终文本。 */
export type BubbleTemplateContext = Record<string, string>;

const BEIJING_OFFSET_MS = 8 * 3_600_000;

function percentText(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '--';
}

function moneyText(value: string | undefined): string {
  return value === undefined || value === '' ? '--' : `¥${value}`;
}

function countdown(ms: string | undefined, now: number): string {
  if (ms === undefined) return '--';
  const at = Date.parse(ms);
  if (!Number.isFinite(at)) return '--';
  return countdownText(Math.max(0, at - now));
}

function priceText(pair: readonly [number, number], peak: boolean): string {
  return `¥${pair[peak ? 1 : 0]}`;
}

/** 由余额状态与时间算出每个占位符的文本；缺数据的占位符显示 `--`。 */
export function bubbleTemplateContext(
  state: BalanceState | undefined,
  whisperText?: string | null,
  now = Date.now(),
): BubbleTemplateContext {
  const windows = state !== undefined && state.ok && state.shape === 'windows' ? state : undefined;
  const account = state !== undefined && state.ok ? (state.accountWallets?.[0] ?? state.wallets?.[0]) : undefined;
  const tier = state !== undefined && state.ok ? (state.accountTier ?? state.tier) : undefined;
  const peak = isPeakAt(now);
  const next = nextSwitchAt(now);
  const date = new Date(now + BEIJING_OFFSET_MS);
  const iso = date.toISOString();
  return {
    balance: account === undefined ? '--' : moneyText(account.total),
    tier: tier === 'peak' ? '峰' : tier === 'idle' ? '谷' : '',
    todaySpend: state !== undefined && state.ok && state.todaySpend !== undefined ? moneyText(state.todaySpend.toFixed(2)) : '--',
    rolling: percentText(windows?.rolling),
    rollingReset: countdown(windows?.rollingResetsAt, now),
    weekly: percentText(windows?.weekly),
    weeklyReset: countdown(windows?.weeklyResetsAt, now),
    peakStatus: peak ? '高峰时段' : '空闲时段（谷价）',
    peakCountdown: next === null ? '--' : (peak ? '距空闲 ' : '距高峰 ') + countdownText(next - now),
    flashHit: priceText(FLASH_PRICE.hit, peak),
    flashMiss: priceText(FLASH_PRICE.miss, peak),
    flashOut: priceText(FLASH_PRICE.out, peak),
    proHit: priceText(PRO_PRICE.hit, peak),
    proMiss: priceText(PRO_PRICE.miss, peak),
    proOut: priceText(PRO_PRICE.out, peak),
    whisper: whisperText ?? '',
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
  };
}

/** 把 `{token}` 换成上下文里的值；不认识的占位符原样保留，方便用户看出拼错。 */
export function fillBubbleTemplate(text: string, context: BubbleTemplateContext): string {
  return text.replace(/\{([a-zA-Z]+)\}/g, (whole, token: string) => {
    const value = context[token];
    return value === undefined ? whole : value;
  });
}

function styleOf(row: BubbleRowTemplate): BubbleRowStyle | undefined {
  const style: BubbleRowStyle = {};
  if (row.color !== undefined && row.color !== '') style.color = row.color;
  if (row.size !== undefined) style.size = row.size;
  if (row.align !== undefined && row.align !== 'left') style.align = row.align;
  if (row.bold === true) style.bold = true;
  return Object.keys(style).length > 0 ? style : undefined;
}

/** 模板 → 气泡行（label 行，除非整行都是小字？统一用 label，配色/字号由 style 决定）。 */
export function renderBubbleTemplate(
  template: readonly BubbleRowTemplate[] | undefined,
  state: BalanceState | undefined,
  whisperText?: string | null,
  now = Date.now(),
): BalanceBubbleRow[] {
  if (template === undefined || template.length === 0) return [];
  const context = bubbleTemplateContext(state, whisperText, now);
  return template.map((row) => {
    const filled = fillBubbleTemplate(row.text, context);
    const text = filled === '' ? ' ' : filled;
    const style = styleOf(row);
    return style === undefined ? { role: 'label', text } : { role: 'label', text, style };
  });
}

/** 设置页预览用样本数据：不依赖真实余额，展示格式与占位符效果。 */
export function sampleBubbleState(): BalanceState {
  return {
    ok: true,
    shape: 'windows',
    provider: 'deepseek-official',
    rolling: 62,
    weekly: 48,
    rollingResetsAt: new Date(Date.now() + 1.9 * 3_600_000).toISOString(),
    weeklyResetsAt: new Date(Date.now() + 4.1 * 86_400_000).toISOString(),
    percentMode: 'remaining',
    account: undefined,
    accountWallets: [{ currency: 'CNY', total: '103.22', granted: '0.00', toppedUp: '103.22', fullBalance: '103.22' }],
    accountTier: 'peak',
    todaySpend: 19.25,
  } as unknown as BalanceState;
}

/** 新建自定义页时的默认行：一条余额 + 一条今日已用，用户再按需改。 */
export const BUBBLE_CUSTOM_DEFAULT_ROWS: readonly BubbleRowTemplate[] = [
  { text: '余额 {balance}', size: 14, align: 'center' },
  { text: '今日已用 {todaySpend}', size: 11, align: 'center' },
];

/**
 * 预置页的「编辑种子」：用户点某一页的「编辑」时用这套占位符预填，
 * 让用户一眼看清这一页能写什么，再逐行改。
 */
export function bubbleStepSeedTemplate(kind: BubblePageKind): BubbleRowTemplate[] {
  switch (kind) {
    case 'summary':
      return [
        { text: '余额 {balance}', size: 15, align: 'left' },
        { text: '今日已用 {todaySpend}', size: 11, align: 'left' },
        { text: '周额度剩 {weekly} · {weeklyReset}', size: 11, align: 'left' },
      ];
    case 'detail':
      return [
        { text: '5h 剩余 {rolling} · {rollingReset}', size: 13, align: 'left' },
        { text: '周剩余 {weekly} · {weeklyReset}', size: 13, align: 'left' },
      ];
    case 'pricing':
      return [
        { text: '{peakStatus} · {peakCountdown}', size: 12, align: 'left' },
        { text: 'Flash {flashHit} / {flashMiss} / {flashOut}', size: 11, align: 'left' },
        { text: 'Pro {proHit} / {proMiss} / {proOut}', size: 11, align: 'left' },
      ];
    case 'whisper':
      return [{ text: '{whisper}', size: 13, align: 'left' }];
    default:
      return BUBBLE_CUSTOM_DEFAULT_ROWS.map((row) => ({ ...row }));
  }
}
