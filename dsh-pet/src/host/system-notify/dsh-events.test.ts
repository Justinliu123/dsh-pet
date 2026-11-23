/**
 * DSH 会话事件帧 → 待转述的通知。
 *
 * 跑法：node --experimental-strip-types --test src/host/system-notify/dsh-events.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dshFrameToNotification } from './dsh-events.ts';
import { DSH_APP_ID } from './notify-text.ts';

describe('dshFrameToNotification', () => {
  test('回合完成：标题固定，正文带回复开头', () => {
    const out = dshFrameToNotification({
      type: 'session/event',
      event: { type: 'turn/end', data: { reason: { kind: 'completed' }, text: '  你好  ' } },
    });
    assert.deepEqual(out, { appId: DSH_APP_ID, title: '对话完成', body: '你好' });
  });

  test('回合完成但没有回复文本：正文空串，不编内容', () => {
    const out = dshFrameToNotification({
      type: 'session/event',
      event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    });
    assert.equal(out?.body, '');
  });

  test('生成失败：正文取错误信息', () => {
    const out = dshFrameToNotification({
      type: 'session/event',
      event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '炸了' } } } },
    });
    assert.equal(out?.title, '生成失败');
    assert.equal(out?.body, '炸了');
  });

  test('被取消 / 中断的回合不说', () => {
    const out = dshFrameToNotification({
      type: 'session/event',
      event: { type: 'turn/end', data: { reason: { kind: 'aborted' } } },
    });
    assert.equal(out, null);
  });

  test('权限申请：工具名与原因拼成正文', () => {
    const out = dshFrameToNotification({ type: 'approval/requested', toolName: 'Bash', reason: '要装包' });
    assert.equal(out?.title, '正在申请权限');
    assert.equal(out?.body, '工具「Bash」：要装包');
  });

  test('等你回答：取第一个问题', () => {
    const out = dshFrameToNotification({ type: 'question/requested', questions: [{ question: '选哪个？' }] });
    assert.equal(out?.title, '模型在等你回答');
    assert.equal(out?.body, '选哪个？');
  });

  test('宿主级失败：说生成失败', () => {
    const out = dshFrameToNotification({ type: 'host/agent-error', message: '网关超时' });
    assert.equal(out?.title, '生成失败');
    assert.equal(out?.body, '网关超时');
  });

  test('不认识的帧返回 null', () => {
    assert.equal(dshFrameToNotification({ type: 'whatever' }), null);
    assert.equal(dshFrameToNotification(null), null);
    assert.equal(dshFrameToNotification(undefined), null);
  });
});
