/**
 * 系统通知文案层：来源判别、截断与说话句式。
 *
 * 跑法：node --experimental-strip-types --test src/host/system-notify/notify-text.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DSH_APP_ID,
  MAX_BODY_CHARS,
  isDshSource,
  notificationSpeech,
  shouldRelay,
  sourceName,
  truncateBody,
} from './notify-text.ts';

describe('truncateBody', () => {
  test('不超长原样返回', () => {
    assert.equal(truncateBody('短消息'), '短消息');
  });

  test('超长截断并加省略号', () => {
    const long = '一'.repeat(MAX_BODY_CHARS + 10);
    const out = truncateBody(long);
    assert.equal(out.length, MAX_BODY_CHARS + 1);
    assert.ok(out.endsWith('…'));
  });
});

describe('isDshSource', () => {
  test('DSH 的两个标识都算 DSH 自己的', () => {
    assert.equal(isDshSource(DSH_APP_ID), true);
    assert.equal(isDshSource('electron.app.DSH NEXT'), true);
  });

  test('第三方应用不算', () => {
    assert.equal(isDshSource('org.yuanli.utools'), false);
    assert.equal(isDshSource('com.tencent.wechat'), false);
  });
});

describe('shouldRelay', () => {
  test('标题正文都空的不说', () => {
    assert.equal(shouldRelay({ appId: 'x', title: '  ', body: '' }), false);
  });

  test('有标题或有正文都说', () => {
    assert.equal(shouldRelay({ appId: 'x', title: '标题', body: '' }), true);
    assert.equal(shouldRelay({ appId: 'x', title: '', body: '正文' }), true);
  });

  test('DSH 来源不因此被挡（会话事件帧要转述）', () => {
    assert.equal(shouldRelay({ appId: DSH_APP_ID, title: '对话完成', body: '' }), true);
  });
});

describe('sourceName', () => {
  test('查表命中', () => {
    assert.equal(sourceName('org.yuanli.utools'), 'uTools');
    assert.equal(sourceName('com.tencent.wechat'), '微信');
    assert.equal(sourceName(DSH_APP_ID), 'DSH');
  });

  test('认不出的取末段', () => {
    assert.equal(sourceName('com.example.mytool'), 'mytool');
  });

  test('末段是通用后缀就不念来源名', () => {
    assert.equal(sourceName('com.example.cn'), '');
    assert.equal(sourceName('org.foo.io'), '');
  });

  test('商店应用的 AUMID 不念来源名', () => {
    assert.equal(sourceName('Microsoft.WindowsStore_8wekyb3d8bbwe!App'), '');
  });
});

describe('notificationSpeech', () => {
  test('形态是「来源：标题 —— 正文」', () => {
    const out = notificationSpeech({ appId: 'com.tencent.wechat', title: '张三', body: '在吗' });
    assert.equal(out, '微信：张三 —— 在吗');
  });

  test('没有正文时不留破折号', () => {
    assert.equal(notificationSpeech({ appId: 'com.tencent.wechat', title: '张三', body: '' }), '微信：张三');
  });

  test('没有来源名时不留冒号', () => {
    assert.equal(notificationSpeech({ appId: 'com.example.cn', title: '标题', body: '正文' }), '标题 —— 正文');
  });

  test('正文超长按上限截断', () => {
    const out = notificationSpeech({ appId: 'com.tencent.wechat', title: 'T', body: '一'.repeat(80) });
    assert.ok(out.includes('…'));
    assert.ok(out.length < 80);
  });

  test('空内容返回空串', () => {
    assert.equal(notificationSpeech({ appId: 'x', title: '', body: '' }), '');
  });
});
