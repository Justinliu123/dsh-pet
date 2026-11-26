/**
 * 插件入口：Cordis 插件，把 host 半侧的配置、路由、斜杠命令、轮询与桌面 Helper 装配到 ctx。
 * 装配顺序不能改：`getHandlePetRoute` 惰性取用（`httpRoute` 在本函数后段才创建），`startHelper` 必须最后调用。
 * @module dsh-pet/src/host/index
 */
import { createHostSetup } from './plugin/setup.ts';
import { readAllConfig } from './config.ts';
import { currentEnvironment, setCityProvider } from './environment.ts';
import { announceDshBridge } from './plugin/bridge-descriptor.ts';
import { bridgeDir } from './data-paths.ts';
import { createHttpRoute, registerHttpRoute } from './plugin/http-route.ts';
import { registerLifecycle } from './plugin/lifecycle.ts';
import { registerChatCommand } from './plugin/command-chat.ts';
import { registerPetCommand } from './plugin/command-pet.ts';
import { registerLoops } from './plugin/loops.ts';
import { registerBalanceCommand } from './plugin/command-balance.ts';
import { registerSessionWatch } from './plugin/session-watch.ts';
import { createDesktopHelper } from './plugin/desktop-helper.ts';
import { createBalancePoll } from './plugin/balance-poll.ts';
import { createSpendTracker } from './spend.ts';
import { createChatMemory } from './plugin/chat-memory.ts';
import { generateChat } from './chat.ts';
import { ensurePowerContextMemory } from './memory/powercontext.ts';
import { createSessionNotify } from './plugin/session-notify.ts';
import { createPetLookup } from './plugin/pet-lookup.ts';
import { createDownloadReport } from './plugin/download-report.ts';
import { createWorkStatusBridge } from './plugin/work-status-bridge.ts';
import { registerTodoReminders } from './plugin/todo-reminders.ts';
import { registerSystemNotify } from './system-notify/loop.ts';
import { DEEPSEEK_OFFICIAL_PROVIDER_ID } from './balance/providers/deepseek-official.ts';
import { ensureDeepseekAsrProvider } from './voice/builtin-deepseek-asr.ts';
import { ensureDeepseekTtsProvider } from './voice/builtin-deepseek-tts.ts';
import { ensureDshSpeechProvider } from './voice/builtin-dsh.ts';
import { ensureEdgeProvider } from './voice/builtin-edge.ts';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createVoiceService } from './voice/speak.ts';
import { createHearService } from './voice/hear.ts';
import { listChatMemoryProviders } from './chat-memory-provider.ts';
import { TODO_FILE_NAME, TodoStore } from './todo/store.ts';
import { join } from 'node:path';
import type { PetRouteDeps } from './routes/types.ts';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ llm（对话模型调用）+ commands（/balance 斜杠命令）+ connection（桌面 Helper「打开 AI 设置」用的已鉴权站点 URL） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands', 'connection'];

/** 检索查询的改写提示词：结合最近几轮还原指代，只要一条能拿去检索的查询，不要解释、不要多行。 */
const REWRITE_QUERY_SYSTEM =
  '把用户这句话改写成一条用于检索长期记忆的查询：结合最近几轮对话还原「它」「那个」「继续」这类指代，保留检索需要的名词与限定词，去掉寒暄、语气词与称呼，不要解释、不要引号、不要换行。只输出这条查询本身。';

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由与斜杠命令（/balance /pet /chat）；ctx 暂用 any（peer 类型包本地不可解析）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  const setup = createHostSetup(ctx);
  const {
    userRoot,
    log,
    configPaths,
    thumbUserRoot,
    memeDirsFor,
    standaloneAiPolicy,
    standaloneAiBalance,
    state,
    playback,
    workStatus,
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
  } = setup;
  const workStatusBridge = createWorkStatusBridge({ state, workStatus, EXTERNAL_WORK_SESSION });
  const { publishWorkStatus, stopWorkStatusFlush } = workStatusBridge;
  const downloadReport = createDownloadReport({
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
    publishWorkStatus,
    workStatus,
  });
  const { reportDownload, stopDownloadSlotTimer } = downloadReport;
  const petLookup = createPetLookup({ state, configPaths });
  const { lock, sleep, sleepRefusalText } = petLookup;
  const sessionNotify = createSessionNotify({ ctx, publishWorkStatus, state, workStatus });
  const {
    pushNotifyFrame,
    turnFlags,
    terminalTimers,
    lastTodoText,
    lastReplyText,
    toolsInFlight,
    cancelTerminalCleanup,
    scheduleTerminalCleanup,
    notifyActivityTimers,
    scheduleCompletionNotify,
  } = sessionNotify;
  // 天气城市覆盖：配置里写了就按它查，不再由 IP 归属地库决定。
  // 只注入这一次——/environment 路由与 system 时间行调的是同一个 currentEnvironment，
  // 各自再去读配置就会出现「气泡说扬州、碎碎念说南京」。
  setCityProvider(() => {
    const city = readAllConfig(configPaths).main?.environmentCity;
    return typeof city === 'string' && city.trim() !== '' ? city.trim() : undefined;
  });
  const chatMemory = createChatMemory({ ctx, configPaths, log, memeDirsFor, playback, state, userRoot });
  const { lastWhisperAt, publishWhisper, chatWithPet, getActivePetId, setActivePetId } = chatMemory;

  // 账户花费推导：DeepSeek 余额差 → 今日已用；余额刷新与气泡组装共用同一份账本。
  const spendTracker = createSpendTracker({ userRoot, log });
  const balancePoll = createBalancePoll({
    ctx,
    configPaths,
    getActivePetId,
    log,
    state,
    standaloneAiBalance,
    spend: spendTracker,
  });
  const { effectivePetList, balancePeriodSec, whisperPeriodSec, refreshBalance, resolveActivePetId, petDisplayName } =
    balancePoll;

  // 待办清单：一份用户级数据（不分宠物），落盘在插件数据根；提醒循环与 /todos 路由共用同一个实例。
  const todos = new TodoStore({ file: join(userRoot, TODO_FILE_NAME), log });

  const desktopHelper = createDesktopHelper({
    ctx,
    configPaths,
    effectivePetList,
    log,
    reportDownload,
    thumbUserRoot,
    // 惰性取用：handlePetRoute 在下方装配，Helper 只在启动/收请求时才真正调用它
    getHandlePetRoute: () => httpRoute.handlePetRoute,
  });
  // startHelper 不再取用：插件是纯数据通道，桌面 Helper 只由独立版自己拉起。
  const { stopHelper, markDisposed } = desktopHelper;

  // 内置语音实现与第三方走同一条注册路径：先登记，两个服务才解析得到各自的实现。
  // 识别那侧惰性依赖宿主服务，没装语音输入插件也能登记——调用时才回 unsupported。
  ensureEdgeProvider();
  ensureDshSpeechProvider({ speechToText: () => setup.optionalService('speechToText') });
  // DeepSeek 官方语音：鉴权复用 DSH 的 DEEPSEEK_API_KEY，与余额那条路一致；
  // 独立模式依次借「语音专用 key」和「余额选 DeepSeek 时的那把」，最后才回落 DSH 凭据
  const resolveDeepseekKey = async (): Promise<string | undefined> => {
    const dedicated = setup.standaloneDeepseekKey();
    if (dedicated) return dedicated;
    const standalone = setup.standaloneAiBalance();
    if (standalone?.provider === DEEPSEEK_OFFICIAL_PROVIDER_ID && standalone.apiKey) return standalone.apiKey;
    const resolved = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'));
    return resolved?.value;
  };
  ensureDeepseekTtsProvider({ resolveKey: resolveDeepseekKey });
  ensureDeepseekAsrProvider({ resolveKey: resolveDeepseekKey });

  /** 读配置里的长期记忆段：每次现读，改完配置不必重启。 */
  const memoryBlock = (): Record<string, unknown> => {
    const block = readAllConfig(configPaths).main?.memory;
    return block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
  };
  /** 读 `memory.powercontext` 里的一项；缺段或类型不对回默认。 */
  const powerContextField = (key: 'endpoint' | 'token'): string => {
    const conf = memoryBlock().powercontext;
    if (!conf || typeof conf !== 'object') return '';
    const value = (conf as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  };
  // 长期记忆：PowerContext 是本机自建服务，地址与令牌来自配置。
  // 查询优化默认关闭——指代指向的通常是刚说过的话，那些轮次本来就在对话历史里；
  // 打开后才复用对话模型改写（空配图池加空动作名单 = 纯文本生成，不注入指令也不解析动作），并带上最近两轮。
  ensurePowerContextMemory({
    endpoint: () => powerContextField('endpoint'),
    token: () => powerContextField('token'),
    rewrite: async ({ userText, history }) => {
      const conf = memoryBlock().powercontext;
      const enabled = conf && typeof conf === 'object' && (conf as Record<string, unknown>).optimizeQuery === true;
      if (!enabled) return undefined;
      const result = await generateChat({
        ctx,
        system: REWRITE_QUERY_SYSTEM,
        history,
        userText,
        pool: [],
        actions: [],
      });
      return result.ok ? result.text : undefined;
    },
  });

  const deps: PetRouteDeps = {
    ...setup,
    ...petLookup,
    ...workStatusBridge,
    ...chatMemory,
    ...balancePoll,
    ...desktopHelper,
    ...sessionNotify,
    ctx,
    todos,
    // 环境查询：/environment 与 system 时间行共用同一个取数口。
    // 传了 city 就照传（空串 = 忽略配置、按 IP 定位，设置页「检测」走这条）；
    // 没传则交回 currentEnvironment 里注入的读取口。
    environment: (opts?: { fresh?: boolean; city?: string }) =>
      currentEnvironment({
        force: opts?.fresh === true,
        ...(opts?.city === undefined ? {} : { city: opts.city }),
      }),
    // 语音合成：缓存落 userRoot，失败只留日志，不打断宿主。
    // 请求没带音色时用配置里的那个值——代码里没有第二份默认音色。
    voice: createVoiceService({
      userRoot,
      log,
      configuredVoice: () => {
        const name = readAllConfig(configPaths).main?.voiceName;
        return typeof name === 'string' && name ? name : undefined;
      },
    }),
    // 语音识别：实现来自注册表；请求没带 provider 时用配置里的那个值，没有第二份默认
    speech: createHearService({
      configuredProvider: () => {
        const provider = readAllConfig(configPaths).main?.speechProvider;
        return typeof provider === 'string' && provider ? provider : undefined;
      },
    }),
    // 长期记忆实现目录：设置页据此渲染下拉，配置项 memoryProvider 的取值就来自它
    memory: { list: listChatMemoryProviders },
  };
  const httpRoute = createHttpRoute(deps);
  registerHttpRoute(ctx, httpRoute.handlePetRoute);

  // 公布宿主入口：DSH 端口每次启动随机，独立桌宠靠这份描述文件发现本宿主（见 plugin/bridge-descriptor）。
  // 文件落在机器级共享桥目录：插件与应用各有自己的数据根，只有这里是两边都认的地址。
  announceDshBridge({ ctx, userRoot: bridgeDir(), log });

  registerSessionWatch({
    ctx,
    cancelTerminalCleanup,
    lastTodoText,
    lastReplyText,
    notifyActivityTimers,
    publishWorkStatus,
    pushNotifyFrame,
    scheduleCompletionNotify,
    scheduleTerminalCleanup,
    terminalTimers,
    toolsInFlight,
    turnFlags,
    workStatus,
  });

  registerBalanceCommand({ ctx, effectivePetList, refreshBalance, sleep, sleepRefusalText });

  // 数据通道模式：插件在 DSH 里跑时只产出数据（余额/工作状态/通知），不生成碎碎念——
  // 文案与语音归独立版所有，否则两边各生成一份、语音各念一遍。独立版（exe / CLI）由自己生成。
  const dataChannelOnly = process.env.DSH_PET_APP_MODE !== '1' && process.env.DSH_PET_IN_PROCESS !== '1';

  registerLoops({
    ctx,
    balancePeriodSec,
    configPaths,
    lastWhisperAt,
    lock,
    log,
    publishWhisper,
    refreshBalance,
    sleep,
    standaloneAiPolicy,
    whisperDisabled: dataChannelOnly,
    whisperPeriodSec,
  });

  registerPetCommand({ ctx, effectivePetList, petDisplayName, resolveActivePetId, setActivePetId });

  registerChatCommand({ ctx, chatWithPet, log, publishWhisper, resolveActivePetId, sleep, sleepRefusalText });

  // 待办提醒：随插件生命周期起停；锁被第三方持有时由 pickReminderSpeaker 跳过该宠物。
  // 播报开关现读现用：改配置后下一次提醒即生效，不必重启。
  registerTodoReminders({
    ctx,
    effectivePetList,
    isVoiceTodoEnabled: () => readAllConfig(configPaths).main?.voiceTodoEnabled === true,
    lock,
    log,
    sleep,
    state,
    todos,
    waiterCount: () => state.waiterCount(),
  });

  // 系统通知转述：她把系统里弹出来的通知读进来，用自己的声音说一遍（写 say 叶子，走现有说话通道）。
  // 只在独立版里装：DSH 侧插件是纯数据通道，两边各生成一份文案、语音就会念两遍。
  // 开关现读现用（配置里的 systemNotifyEnabled）：关着就什么都不做，连通知库都不开。
  if (!dataChannelOnly) {
    registerSystemNotify({
      ctx,
      effectivePetList,
      isEnabled: () => readAllConfig(configPaths).main?.systemNotifyEnabled === true,
      isLocked: (petId) => lock.locked(petId),
      isSleeping: (petId) => sleep.sleeping(petId),
      log,
      readNotifyFrame: () => {
        const leaf = state.read().sections.notify;
        return leaf === undefined ? null : { counter: leaf.counter, data: leaf.data };
      },
      writeSay: (petId, text, duration, voiceTo) => {
        state.writePet(petId, 'say', { text, duration, voiceTo, queued: true });
      },
    });
  }

  registerLifecycle({
    ctx,
    lock,
    markDisposed,
    playback,
    state,
    stopDownloadSlotTimer,
    stopHelper,
    stopWorkStatusFlush,
  });

  // 插件在 DSH 里只当数据通道：不再拉起桌面 Helper、也不在页面里画宠物。
  // 要显示宠物请装独立版（exe）；它通过本插件公布的本机 HTTP 接口读余额/工作状态/通知。
  // 这样同一份代码在两边跑也不会出现两只宠物、两套托盘或两份语音。
}
