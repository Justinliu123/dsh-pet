/**
 * 单家服务商的余额查询：设置页「测试」按钮用它验证某一把密钥。
 *
 * 与 queryStandaloneBalance 的区别只在服务商来源——那边取「当前选中的服务商」，
 * 这里由调用方点名，且密钥可以是还没保存的草稿。
 * @module dsh-pet/src/standalone/ai-provider/provider-balance
 */
import { queryBalance as queryProviderBalanceImpl, type BalanceResult } from '../../host/balance/index.ts';

/**
 * 按指定服务商查一次余额。
 * @param provider - 服务商 id（minimax-cn / minimax / opencode-go / commandcode / deepseek-official …）
 * @param resolveKey - 取密钥；返回 undefined 时 host 半侧落成 credential-missing
 * @returns host 半侧归一化后的结果
 */
export async function queryProviderBalance(
  provider: string,
  resolveKey: (ref: string) => Promise<string | undefined>,
): Promise<BalanceResult> {
  return queryProviderBalanceImpl(provider, resolveKey);
}
