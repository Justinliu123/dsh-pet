/**
 * DeepSeek 峰谷价目与时段倒计时：点击宠物本体时排进气泡序列的第二页。
 *
 * 纯函数，只吃时间戳、只吐气泡行数据；两端渲染器共用同一份文案与数字，不各算一次。
 * 时段规则来自官方口径（北京时间）：周一至周五 9:00–12:00、14:00–18:00 为高峰，
 * 其余时段——含周末、调休上班的周末、中国法定节假日全天——一律按空闲（谷价）计费。
 *
 * @module dsh-pet/src/shared/balance/pricing
 */

import type { BalanceBubbleRow } from './types.ts';

/** 北京时间固定偏移：用平移坐标读 UTC 字段即为北京日历日与钟点，不受运行机器的时区影响。 */
const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000;

/** 高峰时段（北京时间，左闭右开）。 */
const PEAK_HOURS: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [14, 18],
];

/** 周末全天谷价的生效时刻：北京时间 2026-08-23 00:00。 */
const WEEKEND_VALLEY_FROM_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

/** 法定节假日全天谷价的生效时刻：北京时间 2026-09-19 00:00。 */
const HOLIDAY_VALLEY_FROM_MS = Date.UTC(2026, 8, 18, 16, 0, 0);

/**
 * 2026 年放假日期（北京日历日）：只列放假的日子。
 *
 * 调休上班日全部落在周末（2026 年为 1/4、2/14、2/28、5/9、9/20、10/10），本就按周末算谷价，
 * 因此不必单列。每年 11 月国务院发布次年安排后要在这里补下一年的日期。
 */
const HOLIDAY_VALLEY: ReadonlySet<string> = new Set([
  // 元旦
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  // 春节
  '2026-02-15',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  '2026-02-22',
  '2026-02-23',
  // 清明
  '2026-04-04',
  '2026-04-05',
  '2026-04-06',
  // 劳动节
  '2026-05-01',
  '2026-05-02',
  '2026-05-03',
  '2026-05-04',
  '2026-05-05',
  // 端午
  '2026-06-19',
  '2026-06-20',
  '2026-06-21',
  // 中秋
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  // 国庆
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
]);

/**
 * Flash 系列单价（元 / 百万 token）：[空闲, 高峰]。
 *
 * 2026-09-10 起降价：命中 0.02/0.04、未命中 1/2、输出 4/8；Pro 为 Flash 的 3 倍价。
 */
export const FLASH_PRICE = {
  hit: [0.02, 0.04],
  miss: [1, 2],
  out: [4, 8],
} as const;

/** Pro 系列单价（元 / 百万 token）：[空闲, 高峰]。 */
export const PRO_PRICE = {
  hit: [0.15, 0.3],
  miss: [4.5, 9],
  out: [13.5, 27],
} as const;

/** 北京日历日的键（YYYY-MM-DD），用于查节假日表。 */
export function beijingDayKey(ms: number): string {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 该时刻是否处于高峰时段（含周末与法定节假日的谷价规则）。 */
export function isPeakAt(ms: number): boolean {
  if (!Number.isFinite(ms)) return false;
  const bj = new Date(ms + BEIJING_OFFSET_MS);
  if (ms >= WEEKEND_VALLEY_FROM_MS) {
    const dow = bj.getUTCDay();
    if (dow === 0 || dow === 6) return false;
  }
  if (ms >= HOLIDAY_VALLEY_FROM_MS && HOLIDAY_VALLEY.has(beijingDayKey(ms))) return false;
  const hour = bj.getUTCHours();
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true;
  }
  return false;
}

/**
 * 下一个峰谷切换时刻：与 {@link isPeakAt} 完全同源（周末与节假日规则都算进去）。
 *
 * 只需扫北京时间的钟点边界 0/9/12/14/18；最长假期 9 天，扫 12 天留足余量。
 * 返回 null 表示 12 天内没有切换点（当前规则下不会发生），调用方不显示倒计时。
 */
export function nextSwitchAt(ms: number): number | null {
  if (!Number.isFinite(ms)) return null;
  const peak = isPeakAt(ms);
  // 北京当日 00:00 在平移坐标系里的起点
  const dayStart = Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS;
  for (let day = 0; day <= 12; day += 1) {
    for (const hour of [0, 9, 12, 14, 18]) {
      const cand = dayStart + day * DAY_MS + hour * 3_600_000 - BEIJING_OFFSET_MS;
      if (cand <= ms + 1) continue;
      if (isPeakAt(cand) !== peak) return cand;
    }
  }
  return null;
}

/** 倒计时文案：不足一小时报分钟，一小时以上报「N 小时 M 分」。 */
export function countdownText(deltaMs: number): string {
  const totalMinutes = Math.max(1, Math.round(deltaMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return minutes + ' 分钟';
  if (minutes === 0) return hours + ' 小时';
  return hours + ' 小时 ' + minutes + ' 分';
}

/** 单价三元组的展示：`0.02 / 1 / 4`。 */
function priceText(price: { hit: readonly number[]; miss: readonly number[]; out: readonly number[] }, peak: boolean): string {
  const at = peak ? 1 : 0;
  const pick = (pair: readonly number[]): number => pair[at] as number;
  return '¥' + pick(price.hit) + ' / ¥' + pick(price.miss) + ' / ¥' + pick(price.out);
}

/**
 * 峰谷页的气泡行：当前时段 + 距下一次切换的倒计时 + Flash / Pro 的实时单价。
 *
 * 单价跟着当前时段走（高峰取峰价），所以不用用户自己换算两套价格。
 *
 * @param now - 计算时刻，默认当前时间；测试可注入。
 * @returns 气泡行数据（label 大字、sub 小字）。
 */
export function pricingRows(now: number = Date.now()): BalanceBubbleRow[] {
  const peak = isPeakAt(now);
  const next = nextSwitchAt(now);
  const rows: BalanceBubbleRow[] = [
    { role: 'label', text: peak ? '高峰时段' : '空闲时段（谷价）' },
    {
      role: 'sub',
      text: next === null ? '切换时间未知' : '距' + (peak ? '空闲' : '高峰') + ' ' + countdownText(next - now),
    },
    { role: 'label', text: 'Flash ' + priceText(FLASH_PRICE, peak) },
    { role: 'sub', text: 'Pro ' + priceText(PRO_PRICE, peak) + ' · 元/百万 token（命中/未命中/输出）' },
  ];
  return rows;
}
