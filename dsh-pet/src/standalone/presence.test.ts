/**
 * 独立桌宠心跳：写入、刷新、退出清理。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAppPresence } from '../host/plugin/app-presence.ts';
import { startAppPresence } from './presence.ts';

test('启动立即写标记，stop 后清掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-presence-run-'));
  const logs: string[] = [];
  try {
    const handle = startAppPresence(dir, { intervalMs: 5, log: (message) => logs.push(message) });
    try {
      const presence = readAppPresence(dir);
      assert.equal(presence?.pid, process.pid);
      assert.ok(presence !== undefined && Date.now() - presence.heartbeatAt < 5_000);
      assert.ok(logs.some((line) => line.includes('存活标记已写入')));
    } finally {
      handle.stop();
    }
    assert.equal(readAppPresence(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
