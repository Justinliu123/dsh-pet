/**
 * 独立桌宠的 DSH 桥：镜像去重规则、断链重置、与宿主状态仓的对接。
 * 纯规则用 planMirror 单测；集成用临时描述文件 + 假 fetch 跑真实 tick 循环。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bridgeStateOfContext,
  createDshBridge,
  createMirrorSeen,
  IDLE_WORK_STATUS,
  planMirror,
  type BridgeLocalSnapshot,
  type BridgeStateStore,
  type MirrorSeen,
  type RemoteStateSnapshot,
} from './dsh-bridge.ts';
import { writeBridgeDescriptor } from '../host/plugin/bridge-descriptor.ts';

interface FakeStore extends BridgeStateStore {
  readonly snapshot: {
    sections: Record<string, { counter: number; data: unknown }>;
    pets: Record<string, Record<string, { counter: number; data: unknown }>>;
  };
  readonly writes: string[];
}

function fakeStore(): FakeStore {
  const sections: Record<string, { counter: number; data: unknown }> = {};
  const pets: Record<string, Record<string, { counter: number; data: unknown }>> = {};
  const writes: string[] = [];
  let counter = 0;
  return {
    sections,
    pets,
    writes,
    snapshot: { sections, pets },
    read(): BridgeLocalSnapshot {
      return { sections, pets };
    },
    writeSection(name, data) {
      counter += 1;
      sections[name] = { counter, data };
      writes.push(`section:${name}`);
    },
    writePet(petId, leaf, data) {
      counter += 1;
      pets[petId] = { ...(pets[petId] ?? {}), [leaf]: { counter, data } };
      writes.push(`pet:${petId}:${leaf}`);
      return undefined;
    },
  };
}

const remoteState: RemoteStateSnapshot = {
  counter: 99,
  sections: {
    balance: { counter: 7, data: { ok: true, provider: 'minimax-cn', shape: 'windows' } },
    workStatus: { counter: 8, data: { state: 'working', task: '改桥', sessionId: 's1' } },
    notify: { counter: 2, data: { kind: 'turn-end' } },
    env: { counter: 3, data: { city: '上海' } },
    // 不镜像的段：存在也不该被写
    config: { counter: 4, data: {} },
    menu: { counter: 5, data: [] },
    focusSession: { counter: 6, data: { sessionId: 's1' } },
  },
  pets: {
    default: {
      say: { counter: 11, data: { text: '干完了' } },
      anim: { counter: 12, data: 'wave' },
      // 物理状态不镜像：位置只有本机窗口知道
      position: { counter: 13, data: { x: 1, y: 2 } },
    },
  },
};

test('planMirror：首次把所有镜像段与指令叶子写进来', () => {
  const { writes, seen } = planMirror({ remote: remoteState, seen: createMirrorSeen(), localSections: {} });
  const kinds = writes.map((write) => (write.kind === 'section' ? `s:${write.name}` : `p:${write.petId}:${write.leaf}`));
  assert.deepEqual(kinds, ['s:workStatus', 's:notify', 'p:default:say', 'p:default:anim']);
  assert.equal(seen.sections.workStatus, 8);
  assert.equal(seen.pets['default\u0000say'], 11);
});

test('planMirror：counter 未变且本地一致 → 不重复写', () => {
  const first = planMirror({ remote: remoteState, seen: createMirrorSeen(), localSections: {} });
  const localSections = {
    workStatus: remoteState.sections?.workStatus?.data,
    notify: remoteState.sections?.notify?.data,
  };
  const second = planMirror({ remote: remoteState, seen: first.seen, localSections });
  assert.deepEqual(second.writes, []);
});

test('planMirror：counter 未变但本地被别的写入覆盖 → 事实类重写纠正', () => {
  const first = planMirror({ remote: remoteState, seen: createMirrorSeen(), localSections: {} });
  const localSections = {
    workStatus: remoteState.sections?.workStatus?.data,
    notify: { kind: 'local-write' }, // 本地别处写进来的
  };
  const second = planMirror({ remote: remoteState, seen: first.seen, localSections });
  assert.equal(second.writes.length, 1);
  assert.deepEqual(second.writes[0], {
    kind: 'section',
    name: 'notify',
    data: remoteState.sections?.notify?.data,
  });
});

test('planMirror：指令类只在 counter 变化时写（同一句话不重复播）', () => {
  const first = planMirror({ remote: remoteState, seen: createMirrorSeen(), localSections: {} });
  const second = planMirror({
    remote: { ...remoteState, sections: {} },
    seen: first.seen,
    localSections: {},
  });
  assert.deepEqual(second.writes, []);
});

test('planMirror：远端缺段/缺叶子不写 null（缺数据不等于清空）', () => {
  const { writes } = planMirror({
    remote: { sections: { balance: undefined }, pets: { default: undefined } },
    seen: createMirrorSeen(),
    localSections: {},
  });
  assert.deepEqual(writes, []);
  const empty = planMirror({ remote: undefined, seen: createMirrorSeen(), localSections: {} });
  assert.deepEqual(empty.writes, []);
});

test('planMirror：本地没有的内容与远端相同 → 不写；不同 → 写', () => {
  const seen: MirrorSeen = { sections: { notify: 2 }, pets: {} };
  const same = planMirror({
    remote: { sections: { notify: { counter: 2, data: { kind: 'turn-end' } } } },
    seen,
    localSections: { notify: { kind: 'turn-end' } },
  });
  assert.deepEqual(same.writes, []);
  const different = planMirror({
    remote: { sections: { notify: { counter: 2, data: { kind: 'turn-end' } } } },
    seen,
    localSections: { notify: { kind: 'other' } },
  });
  assert.equal(different.writes.length, 1);
});

test('桥集成：读描述文件拉 /state 写进本地仓；断链后工作状态回空闲', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-run-'));
  const store = fakeStore();
  const logs: string[] = [];
  let served = 0;
  try {
    writeBridgeDescriptor(dir, 'http://127.0.0.1:52195');
    const bridge = createDshBridge({
      state: store,
      userRoot: dir,
      intervalMs: 5,
      log: (message) => logs.push(message),
      fetchImpl: (async () => {
        served += 1;
        return new Response(JSON.stringify(remoteState), { status: 200 });
      }) as unknown as typeof fetch,
    });
    try {
      bridge.start();
      await waitFor(() => store.snapshot.sections.workStatus !== undefined);
      assert.deepEqual(store.snapshot.sections.workStatus?.data, remoteState.sections?.workStatus?.data);
      assert.deepEqual(store.snapshot.pets.default?.say?.data, { text: '干完了' });
      // 不镜像的段与叶子一个都不能出现
      assert.equal(store.snapshot.sections.config, undefined);
      assert.equal(store.snapshot.pets.default?.position, undefined);
      assert.ok(served >= 1);
      assert.equal(bridge.status().connected, true);
      assert.ok(logs.some((line) => line.includes('DSH 桥已连接')));

      // 宿主消失（描述文件被删）→ 连续失败 3 次后判开，工作状态写回空闲
      rmSync(join(dir, 'standalone-bridge.json'));
      store.snapshot.sections.workStatus = { counter: 0, data: { state: 'working' } };
      await waitFor(() => bridge.status().connected === false);
      assert.deepEqual(store.snapshot.sections.workStatus?.data, IDLE_WORK_STATUS);
      assert.ok(logs.some((line) => line.includes('DSH 桥已断开')));
    } finally {
      bridge.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('桥集成：没有描述文件时从 DSH 日志兜底发现入口', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-log-'));
  const userRoot = join(dshHome, 'dsh-pet');
  const store = fakeStore();
  const logs: string[] = [];
  const fetches: string[] = [];
  try {
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(join(dshHome, 'logs'));
    writeFileSync(
      join(dshHome, 'logs', 'desktop-next.log'),
      '[info] dsh web: http://127.0.0.1:55555/?token=****\n',
    );
    const bridge = createDshBridge({
      state: store,
      userRoot,
      intervalMs: 5,
      log: (message) => logs.push(message),
      fetchImpl: (async (url: string) => {
        fetches.push(String(url));
        return new Response(JSON.stringify(remoteState), { status: 200 });
      }) as unknown as typeof fetch,
    });
    try {
      bridge.start();
      await waitFor(() => bridge.status().connected === true);
      assert.equal(fetches[0], 'http://127.0.0.1:55555/dsh-pet-7340/state');
      assert.deepEqual(store.snapshot.sections.workStatus?.data, remoteState.sections?.workStatus?.data);
      assert.ok(logs.some((line) => line.includes('DSH 桥已连接：http://127.0.0.1:55555')));
    } finally {
      bridge.stop();
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('bridgeStateOfContext：从伪 ctx 的 get 取状态仓，取不到返回 undefined', () => {
  const store = fakeStore();
  assert.equal(bridgeStateOfContext({ get: () => ({ state: store }) }), store);
  assert.equal(bridgeStateOfContext({}), undefined);
  assert.equal(bridgeStateOfContext(undefined), undefined);
});

/** 轮询等条件成立（最多 ~2s），超时直接断言失败。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时：条件一直没成立');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
