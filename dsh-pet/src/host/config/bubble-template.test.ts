/**
 * bubbleTemplate 配置项：「气泡」分区 → 自定义页的模板行。
 *
 * 契约：非空数组、最多 6 行、text 必填且 ≤120 字、color 只收 #rgb/#rrggbb（挡样式注入）、
 * size 8~48、align 三选一；任何一项写错整段判非法并回退默认。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GLOBAL_DEFAULT_KEYS } from './constants.ts';
import { BUBBLE_ROW_COLORS, bubbleTemplateValid, topFieldValid } from './validate.ts';

test('合法形状：文本 + 可选颜色/字号/对齐', () => {
  assert.equal(bubbleTemplateValid([{ text: '余额 {balance}' }]), true);
  assert.equal(
    bubbleTemplateValid([
      { text: '余额 {balance}', color: '#e6e8ee', size: 15, align: 'center' },
      { text: '今日已用 {todaySpend}', color: '#9aa0aa', size: 10 },
    ]),
    true,
  );
  assert.equal(bubbleTemplateValid([{ text: 'x', color: '#abc' }]), true);
  assert.equal(bubbleTemplateValid([{ text: 'x', bold: true }]), true);
  assert.equal(bubbleTemplateValid([{ text: '{tier}', tierColor: true }]), true);
  assert.equal(bubbleTemplateValid([{ text: '{tier}', tierColor: false }]), true);
});

test('非法形状：空数组、超长、空文本、坏颜色、坏字号、坏对齐都拒', () => {
  assert.equal(bubbleTemplateValid([]), false);
  assert.equal(bubbleTemplateValid(null), false);
  assert.equal(bubbleTemplateValid('余额'), false);
  assert.equal(bubbleTemplateValid([{ text: '' }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x'.repeat(121) }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x', color: 'red' }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x', color: 'rgba(0,0,0,.5)' }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x', size: 7 }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x', size: 49 }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x', align: 'justify' }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x', bold: 'yes' }]), false);
  assert.equal(bubbleTemplateValid([{ text: 'x', tierColor: 'yes' }]), false);
  assert.equal(bubbleTemplateValid(Array.from({ length: 7 }, () => ({ text: 'x' }))), false);
});

test('颜色正则只放行 #rgb/#rrggbb', () => {
  assert.equal(BUBBLE_ROW_COLORS.test('#fff'), true);
  assert.equal(BUBBLE_ROW_COLORS.test('#E6E8EE'), true);
  assert.equal(BUBBLE_ROW_COLORS.test('#ffff'), false);
  assert.equal(BUBBLE_ROW_COLORS.test('style="x"'), false);
});

test('顶层字段白名单认得 bubbleTemplate', () => {
  assert.equal(topFieldValid('bubbleTemplate', [{ text: 'x' }]), true);
  assert.equal(topFieldValid('bubbleTemplate', [{ text: '' }]), false);
  assert.ok(GLOBAL_DEFAULT_KEYS.includes('bubbleTemplate'), '要进全局默认键，否则保存时被丢弃');
});
