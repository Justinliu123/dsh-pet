/**
 * 花费追踪器：余额下降累计为今日已用，充值不计消费，跨天清零，落盘可恢复。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSpendTracker, SPEND_FILE_NAME } from './spend.ts';

/** 造一次成功的 money 余额结果。 */
function money(total: string): {
  ok: true;
  provider: string;
  shape: 'money';
  data: { wallets: { currency: string; total: string; granted: string; toppedUp: string }[] };
} {
  return {
    ok: true,
    provider: 'deepseek-account',
    shape: 'money',
    data: { wallets: [{ currency: 'CNY', total, granted: '0.00', toppedUp: total }] },
  };
}

test('余额下降累计为今日已用，充值不计消费', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-spend-'));
  let clock = Date.UTC(2026, 10, 18, 2, 0, 0); // 北京时间 10:00
  const tracker = createSpendTracker({ userRoot: dir, log: { info() {}, warn() {} }, now: () => clock });
  try {
    tracker.observe(money('10.00'));
    assert.equal(tracker.todaySpend(), 0);
    clock += 60_000;
    tracker.observe(money('9.40'));
    assert.equal(tracker.todaySpend(), 0.6);
    // 充值：余额上升，只更新基准
    clock += 60_000;
    tracker.observe(money('20.00'));
    assert.equal(tracker.todaySpend(), 0.6);
    // 继续消费
    clock += 60_000;
    tracker.observe(money('19.50'));
    assert.ok(Math.abs(tracker.todaySpend() - 1.1) < 1e-9);
    assert.ok(tracker.hasObservation());
    await tracker.flush();
    assert.match(readFileSync(join(dir, SPEND_FILE_NAME), 'utf8'), /"spentToday":1.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨天清零；落盘后可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-spend-'));
  let clock = Date.UTC(2026, 10, 18, 2, 0, 0);
  try {
    const t1 = createSpendTracker({ userRoot: dir, log: { info() {}, warn() {} }, now: () => clock });
    t1.observe(money('10.00'));
    t1.observe(money('8.00'));
    assert.equal(t1.todaySpend(), 2);
    // 次日（北京时间）：同样的余额读数不再算消费，今日从 0 开始
    clock = Date.UTC(2026, 10, 19, 2, 0, 0);
    const t2 = createSpendTracker({ userRoot: dir, log: { info() {}, warn() {} }, now: () => clock });
    t2.observe(money('8.00'));
    assert.equal(t2.todaySpend(), 0);
    t2.observe(money('7.50'));
    assert.equal(t2.todaySpend(), 0.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
