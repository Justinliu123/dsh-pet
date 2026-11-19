/**
 * MiniMax Coding（订阅）额度：5h 与周两个窗口（provider id 跟随宿主模型服务商 id）。
 *
 * 取 GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains（Bearer key）。
 * 接口给的是「剩余百分比」，展示层统一按「已用百分比」画进度条，因此这里折算成已用，
 * 并用 percentMode: 'remaining' 让文案按「剩 x%」呈现；没有月窗口，windows 形态允许
 * monthly 缺省（只列存在的窗口）。
 *
 * 始终成立：两个窗口都取不到即抛错（不伪造 0 额度）；0/负数的重置时间是占位，不换算成 1970 年。
 *
 * @module dsh-pet/src/host/balance/providers/minimax-coding
 */
import { fetchWithRetry, looseNum, obj } from '../internal.ts';
import type { BalanceProvider, BalanceSuccess } from '../types.ts';

/** 国内站额度端点。 */
const CN_URL = 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains';
/** 国际站额度端点（独立账号体系，密钥不通用）。 */
const INTL_URL = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';

/**
 * 毫秒时间戳 → ISO 字符串。
 * @param value - 接口里的 end_time / weekly_end_time（毫秒；兼容秒级）
 * @returns ISO 时间；0、负数与非法值返回 undefined（接口用 0 表示没有该窗口）
 */
function isoTimestamp(value: unknown): string | undefined {
  const n = looseNum(value);
  if (n === undefined || n <= 0) return undefined;
  const ms = n < 1_000_000_000_000 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 接口的「剩余百分比」→ 展示层的「已用百分比」。
 * @param remain - current_interval_remaining_percent / current_weekly_remaining_percent
 * @returns 0..100 的已用百分比；取不到返回 undefined
 */
function usedPercentFromRemain(remain: unknown): number | undefined {
  const r = looseNum(remain);
  if (r === undefined) return undefined;
  return Math.max(0, Math.min(100, 100 - r));
}

/**
 * 解析额度响应（纯函数，测试可直接喂真实报文）。
 * @param body - 接口返回的 JSON
 * @param provider - 回填结果的 provider id
 * @returns windows 形态：rolling（5h）与 weekly（周）两个窗口，percentMode 为 remaining
 * @throws 找不到 model_remains、条目为空或两个窗口都取不到时
 */
export function parseMinimaxRemains(body: unknown, provider: string): BalanceSuccess {
  // MiniMax 把「密钥无效」也回成 HTTP 200，只是 base_resp.status_code 非 0：
  // 不先看这一层，用户会看到「缺少 model_remains」这种答非所问的提示。
  const resp = obj(obj(body)?.base_resp);
  const statusCode = looseNum(resp?.status_code);
  if (statusCode !== undefined && statusCode !== 0) {
    const detail = String(resp?.status_msg ?? '').trim();
    throw new Error(
      'MiniMax 拒绝了这次请求' + (detail !== '' ? '：' + detail : '（status_code ' + String(statusCode) + '）'),
    );
  }
  const list = obj(body)?.model_remains;
  if (!Array.isArray(list)) throw new Error('dsh-pet: MiniMax 额度响应缺少 model_remains');
  const entries = list
    .map((item) => obj(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  // 接口会同时列出 general / video 等条目：coding plan 的对话额度是 general，没有就取第一条。
  const entry = entries.find((item) => item.model_name === 'general') ?? entries[0];
  if (!entry) throw new Error('dsh-pet: MiniMax 额度响应为空');
  const rolling = usedPercentFromRemain(entry.current_interval_remaining_percent);
  const weekly = usedPercentFromRemain(entry.current_weekly_remaining_percent);
  if (rolling === undefined && weekly === undefined) {
    throw new Error('dsh-pet: MiniMax 额度响应缺少窗口百分比');
  }
  const rollingResetsAt = isoTimestamp(entry.end_time);
  const weeklyResetsAt = isoTimestamp(entry.weekly_end_time);
  return {
    ok: true,
    provider,
    shape: 'windows',
    data: {
      ...(rolling === undefined ? {} : { rolling }),
      ...(weekly === undefined ? {} : { weekly }),
      rollingLabel: '5h',
      ...(rollingResetsAt === undefined ? {} : { rollingResetsAt }),
      ...(weeklyResetsAt === undefined ? {} : { weeklyResetsAt }),
      percentMode: 'remaining',
    },
  };
}

/** 国内站：provider id 与 DSH 的 llm-pi-ai 提供商标识一致（minimax-cn），切到该厂商模型时自动生效。 */
export const minimaxCodingCn: BalanceProvider = {
  id: 'minimax-cn',
  credential: { mode: 'ref', ref: 'MINIMAX_CN_API_KEY' },
  async fetch({ key, provider }) {
    const res = await fetchWithRetry(CN_URL, key);
    if (!res.ok) throw new Error('MiniMax 额度 HTTP ' + res.status);
    return parseMinimaxRemains(await res.json(), provider);
  },
};

/** 国际站（provider id minimax，与 DSH llm-pi-ai 的 `minimax` 一致）：与国内站同构，端点与密钥不同。 */
export const minimaxCodingIntl: BalanceProvider = {
  id: 'minimax',
  credential: { mode: 'ref', ref: 'MINIMAX_API_KEY' },
  async fetch({ key, provider }) {
    const res = await fetchWithRetry(INTL_URL, key);
    if (!res.ok) throw new Error('MiniMax 额度 HTTP ' + res.status);
    return parseMinimaxRemains(await res.json(), provider);
  },
};
