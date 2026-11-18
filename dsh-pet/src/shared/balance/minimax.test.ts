/**
 * MiniMax 订阅额度的展示口径：只有 5h 与周两个窗口、接口回传的是剩余百分比。
 *
 * 钉住三件事：没有月窗口也能解析（旧的「月度必有」底线已放开）、percentMode=remaining 时
 * 文案按「剩 x%」、进度条与告警色仍按已用百分比。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBalanceState } from './parse.ts';
import { balanceBubbleView, balanceDetailView, balancePageCount } from './view.ts';

/** 造一条 host 写进 /state 的 windows 叶子。 */
function windowsLeaf(data: Record<string, unknown>): unknown {
  return { ok: true, provider: 'minimax-cn', shape: 'windows', data };
}

test('MiniMax：无月窗口也能解析，并保留剩余口径', () => {
  const state = toBalanceState(
    windowsLeaf({ rolling: 0, weekly: 49, rollingResetsAt: '2026-11-18T10:00:00.000Z', percentMode: 'remaining' }),
  );
  assert.ok(state, '应当解析成功');
  assert.equal(state.ok, true);
  assert.equal(state.shape, 'windows');
  if (!state.ok) return;
  assert.equal(state.monthly, undefined);
  assert.equal(state.rolling, 0);
  assert.equal(state.weekly, 49);
  assert.equal(state.percentMode, 'remaining');
  assert.equal(state.rollingResetsAt, '2026-11-18T10:00:00.000Z');
});

test('MiniMax：收起态说「剩 51%」而不是「已用 49%」', () => {
  const state = toBalanceState(windowsLeaf({ rolling: 0, weekly: 49, percentMode: 'remaining' }));
  assert.ok(state);
  assert.deepEqual(balanceBubbleView(state), [
    { role: 'label', text: '周额度剩 51%' },
    { role: 'sub', text: '重置时间未知' },
  ]);
});

test('MiniMax：展开态逐窗口一行，剩余文案与已用进度并存', () => {
  const state = toBalanceState(windowsLeaf({ rolling: 100, weekly: 49, percentMode: 'remaining' }));
  assert.ok(state);
  assert.equal(balancePageCount(state), 2);
  const rows = balanceDetailView(state);
  assert.equal(rows.length, 2);
  const weekly = rows.find((row) => row.role === 'quota' && row.label === '周');
  assert.ok(weekly);
  if (!weekly || weekly.role !== 'quota') return;
  assert.equal(weekly.percent, 49, '进度条按已用百分比');
  assert.equal(weekly.usedText, '剩 51%', '文案按剩余百分比');
});

test('没有窗口的 windows 叶子不会被当成可用余额', () => {
  assert.equal(toBalanceState(windowsLeaf({})), null);
  // 出现但非法的窗口整拍跳过
  assert.equal(toBalanceState(windowsLeaf({ rolling: 'x', percentMode: 'remaining' })), null);
});

test('缺省口径仍是「已用」，不影响既有服务商', () => {
  const state = toBalanceState(windowsLeaf({ monthly: 12, rolling: 3 }));
  assert.ok(state);
  const rows = balanceBubbleView(state);
  assert.deepEqual(rows, [
    { role: 'label', text: '月额度已用 12%' },
    { role: 'sub', text: '重置时间未知' },
  ]);
});


test('组合视图：账户余额 + 今日已用 + MiniMax 窗口按顺序编排', () => {
  const state = toBalanceState(
    windowsLeaf({
      rolling: 0,
      weekly: 49,
      percentMode: 'remaining',
      account: { wallets: [{ currency: 'CNY', total: '27.37', granted: '0.00', toppedUp: '27.37' }], tier: 'peak' },
      todaySpend: 1.236,
    }),
  );
  assert.ok(state);
  const rows = balanceBubbleView(state);
  assert.deepEqual(
    rows.map((row) => ('text' in row ? row.text : '')),
    ['余额 ¥27.37（峰）', '今日已用 ¥1.24', '周额度剩 51%', '重置时间未知'],
  );
});

test('money 形态也带今日已用（纯 DeepSeek 场景）', () => {
  const state = toBalanceState({
    ok: true,
    provider: 'deepseek-account',
    shape: 'money',
    data: {
      wallets: [{ currency: 'CNY', total: '8.79', granted: '0', toppedUp: '8.79' }],
      tier: 'idle',
      todaySpend: 0.42,
    },
  });
  assert.ok(state);
  const rows = balanceBubbleView(state);
  assert.equal(rows[rows.length - 1]?.role, 'sub');
  assert.equal(rows[rows.length - 1]?.text, '今日已用 ¥0.42');
});
