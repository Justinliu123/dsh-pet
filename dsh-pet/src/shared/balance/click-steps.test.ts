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
