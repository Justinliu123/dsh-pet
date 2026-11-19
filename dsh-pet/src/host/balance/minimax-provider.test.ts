/**
 * MiniMax 额度解析的两类失败：HTTP 层的（res.ok=false）与业务层的（HTTP 200 + base_resp 非 0）。
 *
 * 钉住一件事：密钥无效时必须说「MiniMax 拒绝了这次请求」，而不是让上层看见
 * 「缺少 model_remains」这种答非所问的提示——设置页「测试」按钮直接把这句话展示给用户。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMinimaxRemains } from './providers/minimax-coding.ts';

test('MiniMax：base_resp 非 0 时按「拒绝」报错，并带上服务商原话', () => {
  assert.throws(
    () =>
      parseMinimaxRemains(
        { base_resp: { status_code: 1004, status_msg: 'invalid api key' } },
        'minimax-cn',
      ),
    /MiniMax 拒绝了这次请求：invalid api key/,
  );
});

test('MiniMax：base_resp 缺失或为 0 时照常解析窗口', () => {
  const ok = parseMinimaxRemains(
    {
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 38, current_weekly_remaining_percent: 52 }],
    },
    'minimax-cn',
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.shape, 'windows');
  assert.equal((ok.data as Record<string, unknown>).rolling, 62, '剩余 38% → 已用 62%');
  assert.equal((ok.data as Record<string, unknown>).weekly, 48);
});
