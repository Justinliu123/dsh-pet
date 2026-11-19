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
  const thirteen = Array.from({ length: 13 }, () => ({ kind: 'summary' }));
  assert.equal(bubbleClickStepsValid(thirteen), false);
});

test('每一页都能带自己的内容：id / title / template 合法就收', () => {
  assert.equal(
    bubbleClickStepsValid([
      { kind: 'custom', id: 'c1', title: '余额速览', template: [{ text: '余额 {balance}', color: '#ffd479', size: 16, align: 'center', bold: true }] },
      { kind: 'summary', template: [{ text: '周额度 {weekly}' }] },
    ]),
    true,
  );
  // id 只收字母数字与下划线短横线；title 超 40 字拒；template 非法行拒。
  assert.equal(bubbleClickStepsValid([{ kind: 'custom', id: '有中文' }]), false);
  assert.equal(bubbleClickStepsValid([{ kind: 'custom', title: 'x'.repeat(41) }]), false);
  assert.equal(bubbleClickStepsValid([{ kind: 'custom', template: [{ text: '' }] }]), false);
  assert.equal(bubbleClickStepsValid([{ kind: 'custom', template: [{ text: 'ok', color: 'red' }] }]), false);
  assert.equal(bubbleClickStepsValid([{ kind: 'custom', template: [{ text: 'ok', size: 99 }] }]), false);
  assert.equal(bubbleClickStepsValid([{ kind: 'custom', template: 'nope' }]), false);
});

test('顶层字段白名单认得 bubbleClickSteps', () => {
  assert.equal(topFieldValid('bubbleClickSteps', [{ kind: 'summary' }]), true);
  assert.equal(topFieldValid('bubbleClickSteps', [{ kind: 'weather' }]), false);
  assert.ok(GLOBAL_DEFAULT_KEYS.includes('bubbleClickSteps'), '要进全局默认键，否则保存时被丢弃');
});
