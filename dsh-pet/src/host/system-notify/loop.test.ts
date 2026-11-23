/**
 * 系统通知转述循环：挑承担者、读新通知、入队与念出去。
 *
 * 跑法：node --experimental-strip-types --test src/host/system-notify/loop.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUBBLE_DURATION_MS,
  MAX_PENDING,
  createRelayState,
  pickSpeaker,
  registerSystemNotify,
  tickSystemNotifications,
  type SystemNotifyTickDeps,
} from './loop.ts';
import type { WindowsNotificationReader, WindowsSystemNotification } from './windows.ts';
import type { HostContext } from '../plugin/context.ts';

/** 一只桌宠（醒着、没被占用）。 */
function pet(id: string): Record<string, unknown> {
  return { id };
}

/** 假的通知读取器：库里有一批通知，水位线以上才算新增。 */
function fakeReader(
  options: { maxId?: number; notifications?: WindowsSystemNotification[]; fail?: boolean } = {},
): WindowsNotificationReader {
  const notifications = options.notifications ?? [];
  return {
    readSince(afterId: number): WindowsSystemNotification[] {
      if (options.fail === true) throw new Error('库被锁');
      return notifications.filter((n) => n.id > afterId);
    },
    maxToastId: () => options.maxId ?? 0,
    close: () => {},
  };
}

/** 一条系统通知。 */
function sys(id: number, appId: string, title: string, body = ''): WindowsSystemNotification {
  return { id, appId, title, body, arrivedAt: 1_700_000_000_000 + id };
}

/** 一拍所需的替身：默认一切正常，测试按需覆盖。 */
function fakeDeps(overrides: Partial<SystemNotifyTickDeps> = {}): SystemNotifyTickDeps & {
  said: Array<{ petId: string; text: string; duration: number; voiceTo: string }>;
} {
  const said: Array<{ petId: string; text: string; duration: number; voiceTo: string }> = [];
  const base: SystemNotifyTickDeps = {
    effectivePetList: () => [pet('a')],
    isEnabled: () => true,
    isLocked: () => false,
    isSleeping: () => false,
    log: { info: () => {}, warn: () => {} },
    readNotifyFrame: () => null,
    writeSay: (petId, text, duration, voiceTo) => {
      said.push({ petId, text, duration, voiceTo });
    },
  };
  return Object.assign(base, overrides, { said }) as SystemNotifyTickDeps & {
    said: Array<{ petId: string; text: string; duration: number; voiceTo: string }>;
  };
}

describe('pickSpeaker', () => {
  test('挑桌面上那只', () => {
    assert.deepEqual(
      pickSpeaker([pet('a')], () => false),
      { petId: 'a', voiceTo: 'desktop' },
    );
  });

  test('可见性不再参与挑选：桌宠恒可见，display 字段不影响结果', () => {
    assert.deepEqual(
      pickSpeaker([{ id: 'a', display: 'web' }], () => false),
      { petId: 'a', voiceTo: 'desktop' },
    );
    assert.deepEqual(
      pickSpeaker([{ id: 'a', display: 'none' }], () => false),
      { petId: 'a', voiceTo: 'desktop' },
    );
  });

  test('被占用的跳过，接着挑下一只', () => {
    const pets = [pet('a'), pet('b')];
    const out = pickSpeaker(pets, (id) => id === 'a');
    assert.equal(out?.petId, 'b');
  });

  test('睡着的跳过', () => {
    assert.equal(
      pickSpeaker(
        [pet('a')],
        () => false,
        () => true,
      ),
      null,
    );
  });

  test('空列表没有承担者', () => {
    assert.equal(
      pickSpeaker([], () => false),
      null,
    );
  });
});

describe('tickSystemNotifications', () => {
  test('开关关着：不读库、不念，也不推进水位线', () => {
    const reader = fakeReader({ notifications: [sys(1, 'com.tencent.wechat', '张三')] });
    const deps = fakeDeps({ isEnabled: () => false, reader });
    const state = createRelayState();
    assert.equal(tickSystemNotifications(deps, state), 0);
    assert.equal(deps.said.length, 0);
    assert.equal(state.afterId, 0);
  });

  test('第一次开：存量通知不算新通知（不当新消息念）', () => {
    const reader = fakeReader({ maxId: 7, notifications: [sys(1, 'com.tencent.wechat', '张三')] });
    const deps = fakeDeps({ reader });
    const state = createRelayState();
    assert.equal(tickSystemNotifications(deps, state), 0);
    assert.equal(state.afterId, 7);
    assert.equal(deps.said.length, 0);
    // 再跑一拍：存量那条（Id=1）仍在水位线以下，不会被念出来
    assert.equal(tickSystemNotifications(deps, state), 0);
    assert.equal(deps.said.length, 0);
  });

  test('之后的新通知念出来，形态是「来源：标题 —— 正文」', () => {
    const reader = fakeReader({ maxId: 7, notifications: [sys(8, 'com.tencent.wechat', '张三', '在吗')] });
    const deps = fakeDeps({ reader });
    const state = createRelayState();
    tickSystemNotifications(deps, state);
    assert.equal(tickSystemNotifications(deps, state), 1);
    assert.deepEqual(deps.said, [
      { petId: 'a', text: '微信：张三 —— 在吗', duration: BUBBLE_DURATION_MS, voiceTo: 'desktop' },
    ]);
    assert.equal(state.afterId, 8);
  });

  test('DSH 自己的通知不念，但水位线照样推进（不会反复读）', () => {
    const reader = fakeReader({ maxId: 7, notifications: [sys(9, 'electron.app.DSH NEXT', '回合未能完成')] });
    const deps = fakeDeps({ reader });
    const state = createRelayState();
    tickSystemNotifications(deps, state);
    assert.equal(tickSystemNotifications(deps, state), 0);
    assert.equal(deps.said.length, 0);
    assert.equal(state.afterId, 9);
  });

  test('一条一拍：同一批来三条，三拍才念完', () => {
    const reader = fakeReader({
      maxId: 7,
      notifications: [sys(8, 'a.b.c', '一'), sys(9, 'a.b.c', '二'), sys(10, 'a.b.c', '三')],
    });
    const deps = fakeDeps({ reader });
    const state = createRelayState();
    tickSystemNotifications(deps, state);
    assert.equal(tickSystemNotifications(deps, state), 1);
    assert.equal(tickSystemNotifications(deps, state), 1);
    assert.equal(tickSystemNotifications(deps, state), 1);
    assert.equal(deps.said.length, 3);
  });

  test('没有能说话的宠物时通知不丢：队列留着，等下一拍', () => {
    const reader = fakeReader({ maxId: 7, notifications: [sys(8, 'a.b.c', '一')] });
    const deps = fakeDeps({ reader, effectivePetList: () => [] });
    const state = createRelayState();
    tickSystemNotifications(deps, state);
    assert.equal(tickSystemNotifications(deps, state), 0);
    assert.equal(state.pending.length, 1);
  });

  test('读库失败不推进水位线：下一拍重读，不会漏', () => {
    const deps = fakeDeps({ reader: fakeReader({ maxId: 7, fail: true }) });
    const state = createRelayState();
    tickSystemNotifications(deps, state);
    assert.equal(state.afterId, 7);
    assert.equal(state.primedWindows, true);
    const after = tickSystemNotifications(deps, state);
    assert.equal(after, 0);
    assert.equal(state.afterId, 7);
  });

  test('队列超上限时丢最旧的', () => {
    const many = Array.from({ length: MAX_PENDING + 5 }, (_, i) => sys(i + 1, 'a.b.c', String(i)));
    const deps = fakeDeps({ effectivePetList: () => [], reader: fakeReader({ notifications: many }) });
    const state = createRelayState();
    tickSystemNotifications(deps, state);
    tickSystemNotifications(deps, state);
    assert.equal(state.pending.length, MAX_PENDING);
    assert.equal(state.pending[0]?.title, '5');
  });

  test('DSH 会话事件帧也由她说', () => {
    let counter = 1;
    const deps = fakeDeps({
      readNotifyFrame: () => ({ counter, data: { type: 'question/requested', questions: [{ question: '选哪个？' }] } }),
    });
    const state = createRelayState();
    // 第一拍校准：这一段里已有的内容不算新事件
    assert.equal(tickSystemNotifications(deps, state), 0);
    counter = 2;
    assert.equal(tickSystemNotifications(deps, state), 1);
    assert.equal(deps.said[0]?.text, 'DSH：模型在等你回答 —— 选哪个？');
  });

  test('DSH 段 counter 没变就不重复念', () => {
    const deps = fakeDeps({
      readNotifyFrame: () => ({
        counter: 5,
        data: { type: 'question/requested', questions: [{ question: '选哪个？' }] },
      }),
    });
    const state = createRelayState();
    tickSystemNotifications(deps, state);
    tickSystemNotifications(deps, state);
    tickSystemNotifications(deps, state);
    assert.equal(deps.said.length, 0);
  });
});

describe('registerSystemNotify', () => {
  test('装一个带标签的 effect，清理函数能收掉定时器', () => {
    const labels: string[] = [];
    const cleanups: Array<() => void> = [];
    const ctx = {
      effect(fn: () => () => void, label?: string): () => void {
        labels.push(String(label ?? ''));
        cleanups.push(fn());
        return () => {};
      },
    } as unknown as HostContext;
    registerSystemNotify({
      ctx,
      effectivePetList: () => [pet('a')],
      isEnabled: () => false,
      isLocked: () => false,
      isSleeping: () => false,
      log: { info: () => {}, warn: () => {} },
      readNotifyFrame: () => null,
      writeSay: () => {},
    });
    try {
      assert.deepEqual(labels, ['dsh-pet: system notifications']);
      assert.equal(cleanups.length, 1);
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  });
});
