/**
 * DeepSeek 峰谷价目页：时段判定、切换倒计时与单价文案。
 *
 * 钉住三件事：高峰只认工作日 9–12 / 14–18（北京时间），周末与法定节假日全天谷价，
 * 价目页只在「窗口额度 + DeepSeek 账户余额」的组合视图里出现（纯窗口服务商不该看到 DeepSeek 的价）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBalanceState } from './parse.ts';
import { balancePageCount, balancePageView } from './view.ts';
import { countdownText, isPeakAt, nextSwitchAt, pricingRows } from './pricing.ts';

/** 把北京时间换成 epoch 毫秒（测试里只写北京钟点，别在断言里手算时区）。 */
function bjt(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0);
}

test('高峰时段：工作日 9–12、14–18 是高峰，午休与傍晚不是', () => {
  // 2026-11-18 是星期三
  assert.equal(isPeakAt(bjt(2026, 11, 18, 9, 0)), true);
  assert.equal(isPeakAt(bjt(2026, 11, 18, 11, 59)), true);
  assert.equal(isPeakAt(bjt(2026, 11, 18, 12, 0)), false);
  assert.equal(isPeakAt(bjt(2026, 11, 18, 13, 59)), false);
  assert.equal(isPeakAt(bjt(2026, 11, 18, 14, 0)), true);
  assert.equal(isPeakAt(bjt(2026, 11, 18, 18, 0)), false);
  assert.equal(isPeakAt(bjt(2026, 11, 18, 8, 59)), false);
});

test('高峰时段：周末全天谷价，节假日全天谷价', () => {
  // 2026-11-21 是星期六
  assert.equal(isPeakAt(bjt(2026, 11, 21, 10, 0)), false);
  // 2026-10-01 国庆（星期四）
  assert.equal(isPeakAt(bjt(2026, 10, 1, 10, 0)), false);
  // 2026-08-22（星期六）在「周末全天谷价」生效之前，仍按旧规则算高峰
  assert.equal(isPeakAt(bjt(2026, 8, 22, 10, 0)), true);
});

test('切换倒计时：高峰中点 → 下一个 12 点；空闲中午 → 下一个 14 点', () => {
  assert.equal(nextSwitchAt(bjt(2026, 11, 18, 10, 0)), bjt(2026, 11, 18, 12, 0));
  assert.equal(nextSwitchAt(bjt(2026, 11, 18, 12, 30)), bjt(2026, 11, 18, 14, 0));
  // 周五 18 点之后：下一段高峰是周一 9 点
  assert.equal(nextSwitchAt(bjt(2026, 11, 20, 18, 30)), bjt(2026, 11, 23, 9, 0));
});

test('倒计时文案：不足一小时报分钟，一小时以上报小时与分钟', () => {
  assert.equal(countdownText(90_000), '2 分钟');
  assert.equal(countdownText(3_600_000), '1 小时');
  assert.equal(countdownText(4_500_000), '1 小时 15 分');
});

test('价目行：高峰用峰价、空闲用谷价，都带切换倒计时', () => {
  const peak = pricingRows(bjt(2026, 11, 18, 10, 0));
  assert.equal(peak[0]?.role, 'label');
  assert.equal(peak[0]?.text, '高峰时段');
  assert.equal(peak[1]?.text, '距空闲 2 小时');
  assert.equal(peak[2]?.text, 'Flash ¥0.04 / ¥2 / ¥8');
  assert.match(String(peak[3]?.text), /Pro ¥0\.3 \/ ¥9 \/ ¥27/);

  const idle = pricingRows(bjt(2026, 11, 18, 12, 30));
  assert.equal(idle[0]?.text, '空闲时段（谷价）');
  assert.equal(idle[1]?.text, '距高峰 1 小时 30 分');
  assert.equal(idle[2]?.text, 'Flash ¥0.02 / ¥1 / ¥4');
  assert.match(String(idle[3]?.text), /Pro ¥0\.15 \/ ¥4\.5 \/ ¥13\.5/);
});

test('组合视图：账户余额 + 窗口额度才有峰谷页，纯窗口服务商没有', () => {
  const combined = toBalanceState({
    ok: true,
    provider: 'deepseek-account',
    shape: 'windows',
    data: {
      weekly: 3,
      account: { wallets: [{ currency: 'CNY', total: '11.44', granted: '0', toppedUp: '11.44' }], tier: 'peak' },
    },
  });
  assert.ok(combined && combined.ok);
  if (!combined || !combined.ok) throw new Error('unreachable');
  assert.equal(balancePageCount(combined), 3, '收起 + 明细 + 峰谷价目');
  const rows = balancePageView(combined, 2);
  assert.equal(rows[0]?.role, 'label');
  assert.match(String(rows[0]?.text), /高峰时段|空闲时段/);
  assert.match(String(rows[2]?.text), /^Flash /);

  const windowsOnly = toBalanceState({ ok: true, provider: 'minimax-cn', shape: 'windows', data: { weekly: 49 } });
  assert.ok(windowsOnly && windowsOnly.ok);
  if (!windowsOnly || !windowsOnly.ok) throw new Error('unreachable');
  assert.equal(balancePageCount(windowsOnly), 2, '纯窗口服务商不出现峰谷页');
});

test('编排开关：关明细/关峰谷后页数与内容同源，翻到末页不出空白', () => {
  const combined = toBalanceState({
    ok: true,
    provider: 'deepseek-account',
    shape: 'windows',
    data: {
      weekly: 3,
      account: { wallets: [{ currency: 'CNY', total: '11.44', granted: '0', toppedUp: '11.44' }], tier: 'peak' },
    },
  });
  assert.ok(combined && combined.ok);
  if (!combined || !combined.ok) throw new Error('unreachable');

  // 关掉峰谷页：只剩收起 + 明细，第 2 页（越界）停在明细，不返回空数组
  assert.equal(balancePageCount(combined, { pricing: false }), 2);
  const noPricing = balancePageView(combined, 5, { pricing: false });
  assert.ok(noPricing.length > 0);
  assert.doesNotMatch(String(noPricing[0]?.text), /高峰时段|空闲时段/);
  assert.match(String(noPricing[0]?.text), /已用|余额|额度|重置/);

  // 关掉明细（峰谷一起关）：只剩收起一页，翻页越界也停在收起态
  assert.equal(balancePageCount(combined, { detail: false, pricing: false }), 1);
  const noDetail = balancePageView(combined, 3, { detail: false, pricing: false });
  assert.ok(noDetail.length > 0);
  assert.doesNotMatch(String(noDetail[0]?.text), /高峰时段|空闲时段/);
});
