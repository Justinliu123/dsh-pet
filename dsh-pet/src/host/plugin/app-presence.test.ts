/**
 * 独立桌宠存活标记：DSH 侧据此决定「只当数据源」还是「自己拉一套桌面 Helper」。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  APP_PRESENCE_FILE,
  APP_PRESENCE_STALE_MS,
  appPresencePath,
  clearAppPresence,
  isAppPresenceFresh,
  isStandaloneAppRunning,
  parseAppPresence,
  readAppPresence,
  writeAppPresence,
} from './app-presence.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-presence-'));
}

test('心跳刷新保留 startedAt，读回形状正确', () => {
  const dir = tempRoot();
  try {
    const first = writeAppPresence(dir, { pid: 4242, now: 1_000 });
    assert.equal(first.startedAt, 1_000);
    assert.equal(first.heartbeatAt, 1_000);
    const second = writeAppPresence(dir, { pid: 4242, now: 31_000 });
    assert.equal(second.startedAt, 1_000);
    assert.equal(second.heartbeatAt, 31_000);
    assert.deepEqual(readAppPresence(dir), second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pid 变了 startedAt 跟着变（重启即新生命周期）', () => {
  const dir = tempRoot();
  try {
    writeAppPresence(dir, { pid: 1, now: 1_000 });
    const restarted = writeAppPresence(dir, { pid: 2, now: 5_000 });
    assert.equal(restarted.startedAt, 5_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新鲜度窗口：等于上限算新鲜，超过上限算过期', () => {
  const presence = { version: 1 as const, pid: 1, startedAt: 0, heartbeatAt: 0 };
  assert.equal(isAppPresenceFresh(presence, APP_PRESENCE_STALE_MS), true);
  assert.equal(isAppPresenceFresh(presence, APP_PRESENCE_STALE_MS + 1), false);
});

test('判定运行中三个条件缺一不可：文件、心跳新鲜、pid 活着', () => {
  const dir = tempRoot();
  try {
    // 没有文件
    assert.equal(isStandaloneAppRunning(dir, { isProcessAlive: () => true }), false);

    writeAppPresence(dir, { pid: 4242, now: 1_000 });
    // 新鲜且 pid 活 → 在跑
    assert.equal(
      isStandaloneAppRunning(dir, { now: 1_000, isProcessAlive: (pid) => pid === 4242 }),
      true,
    );
    // pid 死了 → 不在跑（哪怕文件还在、心跳还新）
    assert.equal(isStandaloneAppRunning(dir, { now: 1_000, isProcessAlive: () => false }), false);
    // 心跳过期 → 不在跑（哪怕 pid 还活着：可能是被复用的 pid）
    assert.equal(
      isStandaloneAppRunning(dir, { now: 1_000 + APP_PRESENCE_STALE_MS + 1, isProcessAlive: () => true }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏文件一律当没有独立应用，不抛错', () => {
  const dir = tempRoot();
  try {
    writeFileSync(join(dir, APP_PRESENCE_FILE), '{"version":1,"pid":', 'utf8');
    assert.equal(readAppPresence(dir), undefined);
    assert.equal(isStandaloneAppRunning(dir), false);
    assert.equal(parseAppPresence({ version: 1, pid: 0, startedAt: 0, heartbeatAt: 0 }), undefined);
    assert.equal(parseAppPresence({ version: 1, pid: 2, startedAt: 0, heartbeatAt: Number.NaN }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('退出只清自己那份标记', () => {
  const dir = tempRoot();
  try {
    writeAppPresence(dir, { pid: 111 });
    writeAppPresence(dir, { pid: 222 });
    clearAppPresence(dir, 111);
    assert.equal(readAppPresence(dir)?.pid, 222);
    clearAppPresence(dir, 222);
    assert.equal(existsSync(appPresencePath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
