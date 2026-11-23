/**
 * 待办提醒的单元测试：一拍做什么，以及由哪只宠物开口。
 *
 * 钉住四条：到点才提醒、一次只提醒一条、写完 S 才记提醒时刻、没有宠物或被占用时跳过
 * （跳过也不推进，下一拍会补上）。时间由 `now` 注入，测试不睡真实时间。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/todo-reminders.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { pickReminderSpeaker, tickTodoReminders } from './todo-reminders.ts';
import type { TodoRecord } from '../todo/types.ts';

/** 固定时钟。 */
const NOW = 1_000_000_000;
const MINUTE = 60 * 1000;

/** 造一条待办：只覆盖本文件关心的字段。 */
function todo(overrides: Partial<TodoRecord> = {}): TodoRecord {
  return {
    id: 'todo-1',
    text: '交周报',
    dueAt: NOW + 10 * MINUTE,
    done: false,
    // 创建于 30 分钟前、到期还剩 10 分钟：档位 20 分钟，第一次排期早已到点。
    createdAt: NOW - 30 * MINUTE,
    updatedAt: NOW - 30 * MINUTE,
    completedAt: null,
    lastRemindedAt: null,
    ...overrides,
  };
}

/** 造一条宠物：只带本函数会读的字段（桌宠恒可见，没有显示位置这一维度）。 */
const pet = (id: string): Record<string, unknown> => ({ id });

/** 一拍用的最小替身：记录写入口。`voiceTodo` 缺省开（与成品配置默认不同，测试里按「要念」跑）。 */
function harness(options: {
  todos: TodoRecord[];
  pets?: Record<string, unknown>[];
  locked?: string | null;
  hasListener?: boolean;
  voiceTodo?: boolean;
}) {
  const writes: Array<{ petId: string; leaf: string; data: unknown }> = [];
  const marked: Array<{ id: string; at: number }> = [];
  const deps = {
    todos: {
      list: async () => options.todos,
      markReminded: async (id: string, at: number) => {
        marked.push({ id, at });
      },
    },
    effectivePetList: () => options.pets ?? [pet('main')],
    isVoiceTodoEnabled: () => options.voiceTodo ?? true,
    lock: { locked: (petId: string) => petId === options.locked },
    state: {
      writePet: (petId: string, leaf: string, data: unknown) => {
        writes.push({ petId, leaf, data });
      },
    },
    log: { info: () => undefined, warn: () => undefined },
    now: () => NOW,
    hasListener: () => options.hasListener ?? true,
  };
  return { deps, writes, marked };
}

describe('pickReminderSpeaker —— 挑开口的宠物', () => {
  test('列表里第一只没被占用、没睡着的就它（桌宠恒可见，不再按显示位置挑）', () => {
    assert.equal(
      pickReminderSpeaker([pet('d'), pet('w')], () => false),
      'd',
    );
    assert.equal(
      pickReminderSpeaker([pet('d'), pet('b')], () => false),
      'd',
    );
    assert.equal(
      pickReminderSpeaker([pet('d1'), pet('d2')], () => false),
      'd1',
    );
  });

  test('空 id 跳过', () => {
    assert.equal(
      pickReminderSpeaker([{ id: '' }, { name: '没有 id' }], () => false),
      null,
    );
  });

  test('被占用的跳过；全被占用 → null（这次提醒不丢，下一拍再试）', () => {
    assert.equal(
      pickReminderSpeaker([pet('a'), pet('b')], (id) => id === 'a'),
      'b',
    );
    assert.equal(
      pickReminderSpeaker([pet('a'), pet('b')], () => true),
      null,
    );
  });

  test('空列表 → null', () => {
    assert.equal(
      pickReminderSpeaker([], () => false),
      null,
    );
  });
});

describe('tickTodoReminders —— 一拍', () => {
  test('到点：写进 say，并记下提醒时刻', async () => {
    const { deps, writes, marked } = harness({ todos: [todo()] });
    await tickTodoReminders(deps);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.petId, 'main');
    assert.equal(writes[0]?.leaf, 'say');
    assert.match(String((writes[0]?.data as { text: string }).text), /交周报/);
    assert.deepEqual(marked, [{ id: 'todo-1', at: NOW }]);
  });

  test('没到点 / 已完成 / 无期限 → 什么都不做', async () => {
    for (const list of [
      [todo({ dueAt: NOW + 3 * 24 * 60 * MINUTE, createdAt: NOW })],
      [todo({ done: true })],
      [todo({ dueAt: null })],
    ]) {
      const { deps, writes, marked } = harness({ todos: list });
      await tickTodoReminders(deps);
      assert.equal(writes.length, 0);
      assert.equal(marked.length, 0);
    }
  });

  test('没有宠物 → 不写也不记（下一拍补上，而不是白白丢掉）', async () => {
    const { deps, writes, marked } = harness({ todos: [todo()], pets: [] });
    await tickTodoReminders(deps);
    assert.equal(writes.length, 0);
    assert.equal(marked.length, 0);
  });

  test('唯一的宠物被占用 → 跳过', async () => {
    const { deps, writes, marked } = harness({ todos: [todo()], locked: 'main' });
    await tickTodoReminders(deps);
    assert.equal(writes.length, 0);
    assert.equal(marked.length, 0);
  });

  test('没有端在线 → 不写也不记（等下一个端连上再提醒，避免写进空状态后丢失）', async () => {
    const { deps, writes, marked } = harness({ todos: [todo()], hasListener: false });
    await tickTodoReminders(deps);
    assert.equal(writes.length, 0);
    assert.equal(marked.length, 0);
  });

  test('播报开关关掉：照样弹气泡，但叶子不带 voiceTo（谁都不念）', async () => {
    const { deps, writes } = harness({ todos: [todo()], voiceTodo: false });
    await tickTodoReminders(deps);
    assert.equal(writes.length, 1, '气泡照旧要弹');
    assert.equal('voiceTo' in (writes[0]?.data as object), false, '关掉时不该写这个键');
  });

  test('播报开关打开：voiceTo 恒为 desktop', async () => {
    const { deps, writes } = harness({ todos: [todo()], voiceTodo: true });
    await tickTodoReminders(deps);
    assert.equal((writes[0]?.data as { voiceTo?: string }).voiceTo, 'desktop', '桌宠只在桌面端，恒由桌面端念');
  });

  test('只有一只宠物时也能提醒', async () => {
    const { deps, writes } = harness({ todos: [todo()], pets: [pet('d')] });
    await tickTodoReminders(deps);
    assert.equal(writes[0]?.petId, 'd');
  });

  test('写 say 时带上该由哪一端念：恒为 desktop', async () => {
    const only = harness({ todos: [todo()], pets: [pet('w')] });
    await tickTodoReminders(only.deps);
    assert.equal((only.writes[0]?.data as { voiceTo?: string }).voiceTo, 'desktop');

    const many = harness({ todos: [todo()], pets: [pet('b'), pet('c')] });
    await tickTodoReminders(many.deps);
    assert.equal(
      (many.writes[0]?.data as { voiceTo?: string }).voiceTo,
      'desktop',
      '不管由哪只开口，这一句都由桌面端念',
    );
  });
});
