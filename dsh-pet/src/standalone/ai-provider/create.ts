/**
 * 独立 AI 服务的装配根：初始化设置存储、维护就绪与暂停状态，把生成通道与连接测试接到门面上。
 *
 * 不解析请求（归 ./request）、不定义限额（归 ./limits）、不写通道细节（归 ./stream 与 ./test-connection）。
 * 必须始终成立：设置读不安全时整体失败，不顺势启用环境里的旧凭据。
 * @module dsh-pet/src/standalone/ai-provider/create
 */
import { type StandaloneLogger } from '../context.ts';
import { createAiConfig, type StandaloneAiSettings, type StandaloneAiPublicSettings } from '../ai-config.ts';
import { BUILTIN_SERVICES, CUSTOM_SERVICE, builtinService, sameEndpoint } from '../services.ts';
import type {
  AiRuntime,
  AiStore,
  ModelDiscoveryInput,
  ModelDiscoveryResult,
  StandaloneAiDependencies,
  StandaloneAiService,
} from './types.ts';
import { PROVIDER } from './limits.ts';
import { discoverModels } from './list-models.ts';
import { queryStandaloneBalance } from './balance.ts';
import { queryProviderBalance } from './provider-balance.ts';
import type { BalanceResult } from '../../host/balance/types.ts';
import { createTextStream } from './stream.ts';
import { testAiConnection } from './test-connection.ts';

/**
 * 把余额结果说成一句话：设置页「测试」按钮的反馈用它，成功才走到这里。
 * @param result - host 半侧的归一化结果
 * @returns 可直接展示的摘要（没有可展示数字时给一句兜底）
 */
function describeResult(result: Extract<BalanceResult, { ok: true }>): string {
  const data = (result.data ?? {}) as Record<string, unknown>;
  // 接口给剩余额度的服务商（MiniMax）在 data 里折成了「已用」，展示时按「剩 x%」还原。
  const remaining = data.percentMode === 'remaining';
  const percent = (value: number): string => String(remaining ? 100 - value : value);
  const parts: string[] = [];
  if (typeof data.rolling === 'number') {
    parts.push(remaining ? '5h 剩 ' + percent(data.rolling) + '%' : '5h 已用 ' + percent(data.rolling) + '%');
  }
  if (typeof data.weekly === 'number') {
    parts.push(remaining ? '周 剩 ' + percent(data.weekly) + '%' : '周 已用 ' + percent(data.weekly) + '%');
  }
  const wallets = Array.isArray(data.wallets) ? (data.wallets as Array<Record<string, unknown>>) : [];
  for (const wallet of wallets.slice(0, 2)) {
    if (typeof wallet.total === 'string') {
      parts.push(String(wallet.currency ?? 'CNY') + ' 余额 ' + wallet.total);
    }
  }
  if (typeof data.todaySpend === 'number') parts.push('今日已用 ' + String(data.todaySpend));
  return parts.length > 0 ? '验证通过：' + parts.join(' · ') : '验证通过（这家没有可展示的数字）。';
}

/**
 * 设置页需要的服务商目录：与后端名录同源，前端不再抄一份地址。
 * 自定义排第一且没有地址——它的 profile 永远是用户自己填的那份。
 */
const SERVICE_CATALOG = [
  { id: CUSTOM_SERVICE, label: '自定义', keyName: 'CUSTOM_API_KEY' as const, protocol: 'openai-compatible' as const },
  ...BUILTIN_SERVICES,
];

/**
 * 把服务商目录附在设置视图上。
 * @param settings - 脱敏设置。
 * @returns 设置 + 目录；目录是静态数据，不含任何密钥。
 */
function withCatalog<T extends StandaloneAiPublicSettings>(settings: T): T & { services: typeof SERVICE_CATALOG } {
  return { ...settings, services: SERVICE_CATALOG };
}

/**
 * 保存设置：单飞、先中止在途请求，失败即暂停，等下一次保存成功才恢复。
 * @throws 服务已释放、另一次保存正在进行，或存储层校验/落盘失败时。
 */
async function saveSettings(runtime: AiRuntime, store: AiStore, input: unknown): Promise<StandaloneAiPublicSettings> {
  if (runtime.disposed) throw new Error('Standalone AI is disposed.');
  if (runtime.saving) throw new Error('Standalone AI settings are being saved.');
  runtime.saving = true;
  // 保存期间先中止在途请求，避免旧设置继续产生输出。
  runtime.active?.abort();
  try {
    const result = await store.save(input);
    if (!runtime.disposed) runtime.paused = false;
    return result;
  } catch (error) {
    runtime.paused = true;
    throw error;
  } finally {
    runtime.saving = false;
  }
}

/**
 * 内置服务的模型清单地址与对话地址不同级（opencode 就是），只有草稿地址命中该家时才用它。
 * @param settings - 当前成品配置。
 * @param input - 本次请求里用户填的地址。
 * @returns 显式清单地址；自定义或地址不符时返回 undefined，交回按 baseUrl 推导。
 */
function discoveryUrl(settings: Readonly<StandaloneAiSettings>, input: ModelDiscoveryInput): string | undefined {
  const def = builtinService(settings.service);
  if (!def?.modelsUrl) return undefined;
  const base = (input.baseUrl !== undefined ? input.baseUrl : settings.baseUrl).trim();
  return sameEndpoint(base, def.baseUrl) ? def.modelsUrl : undefined;
}

/**
 * 端点不给模型清单时可以用内置候选的失败原因。
 * 只放「拿不到清单」这一类：地址不对/协议不符/网络不通/404；
 * auth、rate-limit、input 是用户必须看到的真实原因，不能拿候选清单盖掉。
 */
const STATIC_FALLBACK_CODES: ReadonlySet<string> = new Set(['not-found', 'contract', 'http', 'network', 'timeout']);

/**
 * 拉模型，拉不到时退回名录里的内置候选。
 * @param runtime - 运行态，提供传输与当前设置。
 * @param settings - 当前成品设置。
 * @param input - 表单草稿。
 * @returns 端点清单，或内置候选（带 message 说明为什么退化）。
 */
async function discoverWithFallback(
  runtime: AiRuntime,
  settings: Readonly<StandaloneAiSettings>,
  input: ModelDiscoveryInput,
): Promise<ModelDiscoveryResult> {
  const result = await discoverModels(runtime.fetcher, settings, {
    ...input,
    modelsUrl: discoveryUrl(settings, input),
  });
  if (result.ok) return result;
  if (!STATIC_FALLBACK_CODES.has(result.code)) return result;
  // 草稿地址命中某家内置服务时优先用那家的候选，否则用当前选中的服务商。
  const base = (input.baseUrl !== undefined ? input.baseUrl : settings.baseUrl).trim();
  const service = BUILTIN_SERVICES.find((def) => sameEndpoint(base, def.baseUrl)) ?? builtinService(settings.service);
  const models = service?.models;
  if (models === undefined || models.length === 0) return result;
  return {
    ok: true,
    models: models.map((id) => ({ id, name: id })),
    message: `拿不到服务商的模型清单（${result.message}），已改用内置候选；可直接选一个保存。`,
  };
}

/**
 * 创建独立模式 AI 服务。
 * @param home - DSH_HOME。
 * @param logger - 日志出口。
 * @param dependencies - 测试注入的传输与时钟。
 * @returns AI 服务。
 * @throws 设置无法安全读取时抛出。
 */
export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: AiStore;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // 持久化损坏或权限不安全时不能顺势启用环境里的旧凭据，宁可整体失败。
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const runtime: AiRuntime = {
    store,
    logger,
    fetcher: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    disposed: false,
    paused: false,
    saving: false,
    active: undefined,
    ready(): boolean {
      return (
        !runtime.disposed &&
        !runtime.paused &&
        !runtime.saving &&
        !!store.current().model &&
        !!store.current().baseUrl &&
        !!store.current().apiKey
      );
    },
  };
  const modelOf = (): string => store.current().model;

  return {
    currentSelection: () => ({ provider: PROVIDER, model: runtime.ready() ? modelOf() : '' }),
    listProviders: () => (runtime.ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      runtime.ready() && provider === PROVIDER ? [{ id: modelOf(), name: modelOf() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = modelOf(), signal) =>
      runtime.ready() && !signal?.aborted && provider === PROVIDER && model === modelOf()
        ? { id: model, name: model }
        : undefined,
    stream: createTextStream(runtime),
    getSettings: () => withCatalog(store.publicSettings()),
    saveSettings: async (input) => withCatalog(await saveSettings(runtime, store, input)),
    isReady: () => runtime.ready(),
    balanceAuth: () => ({
      provider: store.current().service,
      apiKey: store.current().apiKey,
      keys: { ...store.current().keys },
    }),
    deepseekKey: () => store.current().deepseekApiKey,
    testConnection: (input) =>
      runtime.disposed
        ? Promise.resolve({ ok: false, message: '服务已关闭' })
        : testAiConnection(runtime.fetcher, store.current(), input),
    discoverModels: (input) =>
      runtime.disposed
        ? Promise.resolve({ ok: false, code: 'input', message: '服务已关闭' })
        : discoverWithFallback(runtime, store.current(), input),
    queryBalance: async () =>
      runtime.disposed
        ? { ok: false, provider: '', reason: 'unsupported' }
        : queryStandaloneBalance(store.current().service, store.current().apiKey),
    testProviderKey: async (input) => {
      if (runtime.disposed) return { ok: false, message: '服务已关闭' };
      const info = builtinService(input.service);
      if (info === undefined) {
        // 自定义（或未知 id）不在余额名录里：余额接口无从验证。
        return {
          ok: false,
          message:
            input.service === CUSTOM_SERVICE
              ? '自定义服务商没有余额接口，无法单独验证密钥；填好后点上面的「测试连接」验证对话。'
              : '未知服务商：' + String(input.service),
        };
      }
      const draft = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      const key = draft !== '' ? draft : (store.current().keys?.[info.keyName] ?? '');
      if (key === '') return { ok: false, message: '还没有密钥：先粘贴这把密钥再测试。' };
      const result = await queryProviderBalance(info.id, async () => key);
      if (!result.ok) {
        const reason = result.reason;
        const detail = result.message ? '：' + result.message : '';
        if (reason === 'credential-missing') return { ok: false, message: '密钥为空，没发出去。' };
        if (reason === 'unsupported') return { ok: false, message: '这家服务商没有可用的余额接口。' };
        return { ok: false, message: '验证失败' + detail + '（密钥不对、已过期或该服务未开通）' };
      }
      return { ok: true, message: describeResult(result) };
    },
    dispose() {
      runtime.disposed = true;
      runtime.active?.abort();
    },
  };
}
