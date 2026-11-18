/**
 * bubbleClickSteps 配置项：设置页「气泡」分区里可排序的点击编排队列。
 *
 * 契约：非空数组、最多 8 步、每一步的 kind 必须在四种白名单里、
 * enabled 可选但必须是布尔；类型写错整段判非法（告警并回退默认）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GLOBAL_DEFAULT_KEYS } from './constants.ts';
import { BUBBLE_STEP_KINDS, bubbleClickStepsValid, topFieldValid } from './validate.ts';

test('合法形状：四种 kind 都能用，enabled 可省', () => {
  assert.equal(bubbleClickStepsValid([{ kind: 'summary' }]), true);
  assert.equal(bubbleClickStepsValid([{ kind: 'detail', enabled: false }]), true);
  assert.equal(bubbleClickStepsValid([{ kind: 'pricing', enabled: true }, { kind: 'whisper' }]), true);
  assert.deepEqual(BUBBLE_STEP_KINDS, ['summary', 'detail', 'pricing', 'whisper', 'custom']);
});

test('非法形状：空数组、超长、未知 kind、enabled 类型错都拒', () => {
  assert.equal(bubbleClickStepsValid([]), false);
  assert.equal(bubbleClickStepsValid(null), false);
  assert.equal(bubbleClickStepsValid('summary'), false);
  assert.equal(bubbleClickStepsValid([{ kind: 'weather' }]), false);
  assert.equal(bubbleClickStepsValid([{ kind: 'summary', enabled: 'yes' }]), false);
  assert.equal(bubbleClickStepsValid([null]), false);
  const nine = Array.from({ length: 9 }, () => ({ kind: 'summary' }));
  assert.equal(bubbleClickStepsValid(nine), false);
});

test('顶层字段白名单认得 bubbleClickSteps', () => {
  assert.equal(topFieldValid('bubbleClickSteps', [{ kind: 'summary' }]), true);
  assert.equal(topFieldValid('bubbleClickSteps', [{ kind: 'weather' }]), false);
  assert.ok(GLOBAL_DEFAULT_KEYS.includes('bubbleClickSteps'), '要进全局默认键，否则保存时被丢弃');
});
