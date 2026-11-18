import test from 'node:test';
import assert from 'node:assert/strict';

import { BUBBLE_PLACEHOLDERS, bubbleTemplateContext, fillBubbleTemplate, renderBubbleTemplate } from './template.ts';
import { clickPageCount, clickPageKinds, clickPageView } from './view.ts';
import type { BalanceState } from './types.ts';

const bjt = (y: number, m: number, d: number, h: number, min = 0): number => Date.UTC(y, m - 1, d, h - 8, min);

function state(): BalanceState {
  return {
    ok: true,
    shape: 'windows',
    provider: 'deepseek-official',
    rolling: 62,
    weekly: 48,
    rollingResetsAt: new Date(bjt(2026, 11, 18, 12, 0)).toISOString(),
    weeklyResetsAt: new Date(bjt(2026, 11, 22, 16, 0)).toISOString(),
    percentMode: 'remaining',
    accountWallets: [{ currency: 'CNY', total: '103.22', granted: '0.00', toppedUp: '103.22', fullBalance: '103.22' }],
    accountTier: 'peak',
    todaySpend: 19.25,
  } as unknown as BalanceState;
}

test('占位符替换：已知 token 换成实时数据，未知 token 原样保留', () => {
  const ctx = bubbleTemplateContext(state(), '早点休息', bjt(2026, 11, 18, 10, 0));
  assert.equal(ctx.balance, '¥103.22');
  assert.equal(ctx.rolling, '62%');
  assert.equal(ctx.weekly, '48%');
  assert.equal(ctx.todaySpend, '¥19.25');
  assert.equal(ctx.peakStatus, '高峰时段');
  assert.equal(ctx.whisper, '早点休息');
  assert.equal(ctx.date, '2026-11-18');
  assert.equal(ctx.time, '10:00');
  const filled = fillBubbleTemplate('余额 {balance}，{unknown} 保留', ctx);
  assert.equal(filled, '余额 ¥103.22，{unknown} 保留');
});

test('缺数据时占位符显示 --，不抛错', () => {
  const ctx = bubbleTemplateContext(undefined, null, bjt(2026, 11, 18, 10, 0));
  assert.equal(ctx.balance, '--');
  assert.equal(ctx.rolling, '--');
  assert.equal(ctx.weeklyReset, '--');
});

test('渲染：每行一条 label，颜色/字号/对齐进 style，空行转空格', () => {
  const rows = renderBubbleTemplate(
    [
      { text: '余额 {balance}', color: '#e6e8ee', size: 15, align: 'center' },
      { text: '{peakStatus} · {peakCountdown}', size: 10 },
      { text: '' },
    ],
    state(),
    null,
    bjt(2026, 11, 18, 10, 0),
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { role: 'label', text: '余额 ¥103.22', style: { color: '#e6e8ee', size: 15, align: 'center' } });
  assert.equal(rows[1].text, '高峰时段 · 距空闲 2 小时');
  assert.deepEqual(rows[1].style, { size: 10 });
  assert.equal(rows[2].text, ' ');
});

test('点击编排：custom 步骤只在有模板时出现，页数与内容同源', () => {
  const now = bjt(2026, 11, 18, 10, 0);
  const steps = [{ kind: 'custom' as const }, { kind: 'summary' as const }];
  assert.deepEqual(clickPageKinds(state(), steps, {}, null), ['summary']);
  const withTemplate = clickPageKinds(state(), steps, {}, null, [{ text: '自定义 {balance}' }]);
  assert.deepEqual(withTemplate, ['custom', 'summary']);
  assert.equal(clickPageCount(state(), steps, {}, null, [{ text: 'x' }]), 2);
  const rows = clickPageView(state(), 0, steps, {}, null, [{ text: '自定义 {balance}' }]);
  assert.equal(rows[0]?.text, '自定义 ¥103.22');
});

test('占位符目录覆盖价格与时间，供设置页下拉使用', () => {
  const tokens = BUBBLE_PLACEHOLDERS.map((item) => item.token);
  for (const token of ['balance', 'todaySpend', 'rolling', 'weekly', 'peakStatus', 'peakCountdown', 'flashHit', 'proOut', 'whisper', 'date', 'time']) {
    assert.ok(tokens.includes(token), token);
  }
});
