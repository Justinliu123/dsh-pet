/**
 * bubbleClickPages 配置项：设置页「气泡」分区保存的两页开关。
 *
 * 契约三件：只收 detail / pricing 两个布尔（缺键合法，消费端按 true）；
 * 类型写错整段判非法（告警并回退默认）；顶层白名单认得这个键。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GLOBAL_DEFAULT_KEYS } from './constants.ts';
import { bubbleClickPagesValid, topFieldValid } from './validate.ts';

test('合法形状：缺键、单键、双键都过', () => {
  assert.equal(bubbleClickPagesValid({}), true);
  assert.equal(bubbleClickPagesValid({ detail: true }), true);
  assert.equal(bubbleClickPagesValid({ pricing: false }), true);
  assert.equal(bubbleClickPagesValid({ detail: true, pricing: false }), true);
  // 多余子键不算非法：消费端只读两个已知键
  assert.equal(bubbleClickPagesValid({ detail: true, extra: 1 }), true);
});

test('非法形状：非对象、数组、子键类型写错都拒', () => {
  assert.equal(bubbleClickPagesValid(null), false);
  assert.equal(bubbleClickPagesValid(undefined), false);
  assert.equal(bubbleClickPagesValid('detail'), false);
  assert.equal(bubbleClickPagesValid([]), false);
  assert.equal(bubbleClickPagesValid({ detail: 'yes' }), false);
  assert.equal(bubbleClickPagesValid({ pricing: 1 }), false);
});

test('顶层字段白名单认得 bubbleClickPages', () => {
  assert.equal(topFieldValid('bubbleClickPages', { detail: false }), true);
  assert.equal(topFieldValid('bubbleClickPages', { detail: 'no' }), false);
  assert.ok(GLOBAL_DEFAULT_KEYS.includes('bubbleClickPages'), '要进全局默认键，否则保存时被丢弃');
});
