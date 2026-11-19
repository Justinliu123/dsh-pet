import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toBalanceState } from './parse.ts';
import { kindPreviews } from './preview.ts';

const money = toBalanceState({
  ok: true,
  provider: 'deepseek-official',
  shape: 'money',
  data: {
    wallets: [{ currency: 'CNY', total: '89.21', toppedUp: '89.21', granted: '0', fullBalance: '20' }],
    tier: 'idle',
    todaySpend: 11.66,
  },
});

const windows = toBalanceState({
  ok: true,
  provider: 'minimax-cn',
  shape: 'windows',
  data: {
    rolling: 62,
    weekly: 48,
    percentMode: 'remaining',
    rollingResetsAt: '2026-11-19T12:00:00.000Z',
    weeklyResetsAt: '2026-11-23T00:00:00.000Z',
    accountWallets: [{ currency: 'CNY', total: '103.22', toppedUp: '103.22', granted: '0', fullBalance: '20' }],
    accountTier: 'peak',
    todaySpend: 19.25,
  },
});

describe('设置页预览：用真实余额算出各预置页的行', () => {
  it('账户金额形态：摘要带档位字、明细是钱包拆分，都不含周额度', () => {
    assert.ok(money);
    const previews = kindPreviews(money);
    const summary = previews.summary ?? [];
    const detail = previews.detail ?? [];
    assert.deepEqual(
      summary.map((row) => row.text),
      ['余额（', '谷', '）¥89.21', '今日已用 ¥11.66'],
    );
    assert.deepEqual(
      detail.map((row) => row.text),
      ['CNY ¥89.21', '充值 ¥89.21', '今日已用 ¥11.66'],
    );
    assert.equal(
      [...summary, ...detail].some((row) => row.text.includes('周额度')),
      false,
    );
  });

  it('窗口形态：摘要有窗口与今日已用，明细是 5h/周两行进度条', () => {
    assert.ok(windows);
    const previews = kindPreviews(windows);
    const summary = (previews.summary ?? []).map((row) => row.text).join('|');
    const detail = (previews.detail ?? []).map((row) => row.text).join('|');
    assert.match(summary, /今日已用 ¥19\.25/);
    assert.match(summary, /5h额度剩 38%/);
    assert.match(detail, /5h 剩 38%/);
    assert.match(detail, /周 剩 52%/);
  });

  it('峰谷页只对 DeepSeek 出现：MiniMax 不算', () => {
    assert.ok(windows);
    assert.equal(kindPreviews(windows).pricing, undefined);
    assert.ok(money);
    assert.ok(kindPreviews(money).pricing?.length);
  });

  it('查不到余额时只有摘要（报错行），没有明细与峰谷', () => {
    const failed = toBalanceState({ ok: false, provider: 'custom', reason: 'unsupported' });
    assert.ok(failed);
    const previews = kindPreviews(failed);
    assert.deepEqual(Object.keys(previews), ['summary']);
    assert.match((previews.summary ?? []).map((row) => row.text).join('|'), /暂不支持余额查询/);
  });
});
