/**
 * 点击编排队列（bubbleClickSteps）的共享层语义：顺序、跳过、去重与页数/内容同源。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BalanceState } from './types.ts';
import {
  DEFAULT_BUBBLE_CLICK_STEPS,
  clickPageCount,
  clickPageKinds,
  clickPageView,
} from './view.ts';

const combined = {
  ok: true,
  shape: 'windows',
  provider: 'deepseek-official',
  rolling: 30,
  weekly: 50,
  rollingResetsAt: '2026-11-18T12:00:00.000Z',
  weeklyResetsAt: '2026-11-22T16:00:00.000Z',
  percentMode: 'remaining',
  accountWallets: [{ currency: 'CNY', total: '11.44', granted: '0.00', toppedUp: '11.44', fullBalance: '20' }],
  accountTier: 'peak',
  todaySpend: 1.2,
} as unknown as BalanceState;

const windowsOnly = {
  ok: true,
  shape: 'windows',
  provider: 'minimax-cn',
  rolling: 30,
  weekly: 50,
  rollingResetsAt: '2026-11-18T12:00:00.000Z',
  weeklyResetsAt: '2026-11-22T16:00:00.000Z',
  percentMode: 'remaining',
} as unknown as BalanceState;

test('缺省队列：收起 → 明细 → 峰谷（组合视图三页）', () => {
  assert.deepEqual(clickPageKinds(combined), ['summary', 'detail', 'pricing']);
  assert.equal(clickPageCount(combined), 3);
  assert.deepEqual(clickPageView(combined, 0), clickPageView(combined, -5), '越界夹到首页');
  assert.equal(clickPageCount(combined, DEFAULT_BUBBLE_CLICK_STEPS, { pricing: false }), 2);
});

test('顺序即点击顺序：把 pricing 提前后第一页变成峰谷价目', () => {
  const steps = [{ kind: 'pricing' }, { kind: 'summary' }] as const;
  assert.deepEqual(clickPageKinds(combined, steps), ['pricing', 'summary']);
  const first = clickPageView(combined, 0, steps);
  assert.match(first[0].text, /高峰|空闲/);
});

test('enabled:false 跳过；whisper 只在有文案时出现', () => {
  const steps = [{ kind: 'whisper' }, { kind: 'summary' }, { kind: 'detail', enabled: false }] as const;
  assert.deepEqual(clickPageKinds(combined, steps, {}, null), ['summary']);
  assert.deepEqual(clickPageKinds(combined, steps, {}, '你好'), ['whisper', 'summary']);
  const whisperPage = clickPageView(combined, 0, steps, {}, '你好');
  assert.deepEqual(whisperPage, [{ role: 'label', text: '你好' }]);
});

test('去重保序；全关退回收起态', () => {
  const steps = [{ kind: 'detail' }, { kind: 'summary' }, { kind: 'detail' }] as const;
  assert.deepEqual(clickPageKinds(combined, steps), ['detail', 'summary']);
  const allOff = [{ kind: 'detail', enabled: false }, { kind: 'pricing', enabled: false }] as const;
  assert.deepEqual(clickPageKinds(combined, allOff), ['summary']);
});

test('纯窗口服务商没有峰谷页；关掉明细时用量页一起去掉', () => {
  assert.deepEqual(clickPageKinds(windowsOnly), ['summary', 'detail']);
  const withUsage = { ...combined, usage: { inputTokens: 1, outputTokens: 2 } } as unknown as BalanceState;
  assert.deepEqual(clickPageKinds(withUsage), ['summary', 'detail', 'usage', 'pricing']);
  assert.deepEqual(clickPageKinds(withUsage, DEFAULT_BUBBLE_CLICK_STEPS, { detail: false }), ['summary', 'pricing']);
});

test('多份自定义页：各带各的模板，按队列顺序依次弹出', () => {
  const steps = [
    { kind: 'custom', id: 'c1', title: '余额速览', template: [{ text: '余额 {balance}', size: 16 }] },
    { kind: 'custom', id: 'c2', title: '额度速览', template: [{ text: '周剩余 {weekly}', size: 12 }] },
    { kind: 'summary' },
  ] as const;
  assert.deepEqual(clickPageKinds(combined, steps), ['custom', 'custom', 'summary']);
  assert.equal(clickPageCount(combined, steps), 3);
  const first = clickPageView(combined, 0, steps);
  assert.match(first[0].text, /余额/);
  const second = clickPageView(combined, 1, steps);
  assert.match(second[0].text, /周剩余/);
  assert.equal(second[0].style?.size, 12);
});

test('编辑过的预置页用自己的模板；没编辑的仍走内置内容', () => {
  const edited = [{ kind: 'summary', template: [{ text: '只剩 {balance}' }] }, { kind: 'detail' }] as const;
  assert.deepEqual(clickPageKinds(combined, edited), ['summary', 'detail']);
  const rows = clickPageView(combined, 0, edited);
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /只剩/);
  // 明细页自带模板时不再拆出「用量」页——那一页已经是用户自己定义的样子。
  const withUsage = { ...combined, usage: { inputTokens: 1, outputTokens: 2 } } as unknown as BalanceState;
  const detailOwn = [{ kind: 'detail', template: [{ text: '5h {rolling}' }] }] as const;
  assert.deepEqual(clickPageKinds(withUsage, detailOwn), ['detail']);
  assert.equal(clickPageCount(withUsage, detailOwn), 1);
});

test('自定义页没有内容就不出现（旧配置里的全局模板仍可回落）', () => {
  const empty = [{ kind: 'custom', id: 'c1' }, { kind: 'summary' }] as const;
  assert.deepEqual(clickPageKinds(combined, empty), ['summary']);
  const legacy = [{ kind: 'custom', id: 'c1' }, { kind: 'summary' }] as const;
  const rows = clickPageView(combined, 0, legacy, {}, null, [{ text: '余额 {balance}' }]);
  assert.match(rows[0].text, /余额/);
});

test('纯账户金额（DeepSeek 官方 key）也有明细与峰谷页', () => {
  const money = {
    provider: 'deepseek-official',
    shape: 'money',
    ok: true,
    wallets: [{ currency: 'CNY', total: '93.05', granted: '0', toppedUp: '93.05', fullBalance: '100' }],
    todaySpend: 7.82,
  } as unknown as BalanceState;
  assert.deepEqual(clickPageKinds(money), ['summary', 'detail', 'pricing']);
  const detail = clickPageView(money, 1);
  assert.ok(detail.some((row) => /满额/.test(row.text)));
  assert.ok(detail.some((row) => /今日已用/.test(row.text)));
});

test('非 DeepSeek 的账户金额不显示峰谷页，但仍有明细页', () => {
  const other = {
    provider: 'opencode-go',
    shape: 'money',
    ok: true,
    wallets: [{ currency: 'USD', total: '5', granted: '0', toppedUp: '5' }],
  } as unknown as BalanceState;
  assert.deepEqual(clickPageKinds(other), ['summary', 'detail']);
});

test('新队列优先：旧的两个开关不会把队列里的明细/峰谷吃掉', () => {
  const queue = [{ kind: 'summary' }, { kind: 'detail' }, { kind: 'pricing' }] as const;
  // 老配置里 detail:false（用户手改配置时会残留），队列显式列了明细就该照队列走。
  assert.deepEqual(clickPageKinds(combined, queue, { detail: false, pricing: false }), [
    'summary',
    'detail',
    'pricing',
  ]);
  // 不传队列时（旧口径）这两个开关仍然生效。
  assert.deepEqual(clickPageKinds(combined, DEFAULT_BUBBLE_CLICK_STEPS, { detail: false }), ['summary', 'pricing']);
});
