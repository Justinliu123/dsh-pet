import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUBBLE_CUSTOM_DEFAULT_ROWS,
  BUBBLE_PLACEHOLDERS,
  bubbleStepSeedTemplate,
  bubbleTemplateContext,
  fillBubbleTemplate,
  renderBubbleTemplate,
} from './template.ts';
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

  const bolded = renderBubbleTemplate([{ text: '余额 {balance}', bold: true }], state(), null, bjt(2026, 11, 18, 10, 0));
  assert.deepEqual(bolded[0].style, { bold: true }, '加粗要带进 style，两端按 700 字重渲染');

  assert.deepEqual(rows[1].style, { size: 10 });
  assert.equal(rows[2].text, ' ');
});

test('随峰谷变色：高峰红、空闲绿，并且优先于模板自带的 color', () => {
  const peakState: BalanceState = { ...state(), accountTier: 'peak' };
  const peak = renderBubbleTemplate(
    [{ text: '{tier} · {peakCountdown}', color: '#32716a', tierColor: true }],
    peakState,
    null,
    bjt(2026, 11, 18, 10, 0),
  );
  assert.deepEqual(peak[0].style, { color: '#e0433f' }, '高峰用鲸鱼挂件的红 #e0433f');

  const idleState: BalanceState = { ...state(), accountTier: 'idle' };
  const idle = renderBubbleTemplate(
    [{ text: '{tier} · {peakCountdown}', color: '#32716a', tierColor: true }],
    idleState,
    null,
    bjt(2026, 11, 18, 22, 0),
  );
  assert.deepEqual(idle[0].style, { color: '#2fa24c' }, '空闲用鲸鱼挂件的绿 #2fa24c');

  const plain = renderBubbleTemplate([{ text: '余额', color: '#32716a' }], peakState, null, bjt(2026, 11, 18, 10, 0));
  assert.deepEqual(plain[0].style, { color: '#32716a' }, '没开开关就照模板自己的颜色');

  const noTier: BalanceState = { ...state() };
  delete noTier.accountTier;
  delete noTier.tier;
  const fallback = renderBubbleTemplate([{ text: '余额', color: '#32716a', tierColor: true }], noTier, null, bjt(2026, 11, 18, 10, 0));
  assert.deepEqual(fallback[0].style, { color: '#32716a' }, '拿不到档位时回落到模板颜色');
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

test('纯 money 形态：{balance} 与 {tier} 回落到 wallets/tier，不显示 --', () => {
  const state = {
    ok: true,
    provider: 'deepseek-official',
    shape: 'money',
    wallets: [{ currency: 'CNY', total: '94.93' }],
    tier: 'idle',
    todaySpend: 5.94,
  };
  const ctx = bubbleTemplateContext(state, null, Date.parse('2026-11-19T12:00:00Z'));
  assert.equal(ctx.balance, '¥94.93');
  assert.equal(ctx.tier, '谷');
  assert.equal(ctx.todaySpend, '¥5.94');
});

test('预置页的编辑种子：每一页都有可用的占位符模板', () => {
  const summary = bubbleStepSeedTemplate('summary');
  assert.ok(summary.length > 0);
  assert.match(summary[0].text, /\{balance\}/);
  const pricing = bubbleStepSeedTemplate('pricing');
  assert.ok(pricing.some((row) => row.text.includes('{peakStatus}')));
  const whisper = bubbleStepSeedTemplate('whisper');
  assert.match(whisper[0].text, /\{whisper\}/);
  // 自定义页新建时的默认行。
  assert.ok(BUBBLE_CUSTOM_DEFAULT_ROWS.length > 0);
  assert.match(BUBBLE_CUSTOM_DEFAULT_ROWS[0].text, /\{balance\}/);
});
