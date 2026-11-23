/**
 * 梦话闸门的单元测试：关掉碎碎念的宠物，睡眠期间也不生成。
 *
 * 钉住 #355：碎碎念循环与梦话循环同一道闸（宠物自己的碎碎念开关），
 * `whisperEnabled: false` 的宠物睡着时不该每拍调一次模型。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/loops.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldSleepTalk } from './loops.ts';

describe('shouldSleepTalk —— 梦话闸门', () => {
  test('开着碎碎念：说梦话', () => {
    assert.equal(shouldSleepTalk({ whisperEnabled: true }), true);
  });

  test('关掉碎碎念：一律不生成', () => {
    assert.equal(shouldSleepTalk({ whisperEnabled: false }), false);
  });

  test('没写 whisperEnabled：按关闭处理，不默认开', () => {
    assert.equal(shouldSleepTalk({}), false);
    assert.equal(shouldSleepTalk({ whisperEnabled: 'true' }), false, '非布尔值不算开启');
  });

  test('可见性不再参与判定：宠物恒可见，display 字段不影响结果', () => {
    assert.equal(shouldSleepTalk({ whisperEnabled: true, display: 'none' }), true, 'display 字段不再影响判定');
    assert.equal(shouldSleepTalk({ whisperEnabled: true }), true, '缺 display 不等于不可见');
  });
});
