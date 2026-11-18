/**
 * 气泡单槽：余额、说话、工作状态三种气泡的显隐、停留计时与优先级选择。
 * 不负责何时点亮与动画联动：tick 判定、抽动画、打日志都在 PetCard；也不负责外观，哑组件在 client/bubble.ts。
 * 依赖注入的 react 与两个气泡组件；三个停留计时器都归本模块清理。
 * 不变量：同一时刻只渲染一个气泡，优先级依次为终态任务、说话、余额、非终态任务。
 * @module dsh-pet/src/client/pet/card/bubble-slots
 */
import {
  clickPageCount as clickPageCountOf,
  balancePageCount as balancePageCountOf,
  type BalanceState,
  type BubbleClickStep,
  type BubbleRowTemplate,
  type BubblePageOptions,
} from '../../../shared/balance/index.ts';
import {
  BUBBLE_HOLD_IDLE,
  reduceBubbleHold,
  utteranceToHold,
  type BubbleHoldEvent,
  type BubbleHoldState,
} from '../../../shared/bubble-hold.ts';
import { subscribeVoiceState, subscribeVoiceUtterance, type VoiceState } from '../../../shared/voice.ts';
import type { EnvState } from '../../../shared/state.ts';
import { BUBBLE_DURATION_MS } from '../timings.ts';
import { subscribePetClicked } from './pet-click.ts';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 当前该挂哪个气泡；`none` 表示哪个条件都不成立。 */
export type BubbleSlot = 'todo' | 'work-terminal' | 'whisper' | 'balance' | 'env' | 'work' | 'none';

/** 优先级判定的输入：全部是渲染期的既成事实，判定本身不产生副作用。 */
export interface BubbleSlotInput {
  /** 待办面板是否打开；打开时独占槽位，其余气泡一律让位。 */
  todoOn: boolean;
  /** 工作状态是否为终态（success / error）。 */
  workTerminal: boolean;
  /** 工作状态是否为「等待确认」（ask_user_question 等人）：用户不点流程就卡住，优先级最高。 */
  workWaiting: boolean;
  /** 工作气泡是否点亮。 */
  workOn: boolean;
  /** 工作气泡文本。 */
  workText: string | null;
  /** 配置是否启用工作状态联动。 */
  workStatusEnabled: boolean;
  /** 说话气泡是否点亮。 */
  whisperOn: boolean;
  /** 说话气泡文本。 */
  whisperText: string | null;
  /** 余额气泡是否点亮。 */
  balanceOn: boolean;
  /** 余额数据是否已拉到；null 表示尚未拉到。 */
  balanceAvailable: boolean;
  /** 配置是否启用余额。 */
  balanceEnabled: boolean;
  /** 本次余额是否手动请求；手动请求不受开关门控。 */
  balanceManual: boolean;
  /** 这次余额气泡是否由「点宠物本体」发起：点击编排盖过任务状态与碎碎念。 */
  balanceClicked: boolean;
  /** 环境气泡是否点亮。 */
  envOn: boolean;
  /** 环境数据是否已到达；null 表示还没有可用数据。 */
  envAvailable: boolean;
}

/**
 * 决定当前挂哪个气泡。
 *
 * 优先级：待办面板 > 提醒确认（waiting）> 点击编排的余额 > 终态任务 > 碎碎念 >
 * 自动余额 > 环境 > 非终态任务。终态与点击气泡都只活 10s，被顶掉就彻底看不到，所以不让位；
 * 非终态与自动来源常驻，让位 10s 没有损失。
 *
 * @param input - 各气泡的显隐与开关。
 * @returns 命中的槽位；都不成立时为 `none`。
 */
export function decideBubbleSlot(input: BubbleSlotInput): BubbleSlot {
  // 面板是用户主动打开的窗口：它占槽时其余气泡一律让位，关掉后按原规则恢复。
  if (input.todoOn) return 'todo';
  // 提醒确认（waiting）插到最前：用户不点「确认」，这一轮就卡在那里，别的气泡再自然也不该盖过它。
  if (input.workWaiting && input.workOn && input.workText && input.workStatusEnabled) return 'work';
  // 点击编排是用户主动发起的查询（点一下宠物就要看到余额），盖过任务状态与碎碎念；
  // 它只活 10s，被自动轮询顶掉就等于「点了没反应」，所以优先级排在自动来源前面。
  if (input.balanceClicked && input.balanceOn && input.balanceAvailable) return 'balance';
  if (input.workTerminal && input.workOn && input.workText && input.workStatusEnabled) return 'work-terminal';
  if (input.whisperOn && input.whisperText) return 'whisper';
  if (input.balanceOn && input.balanceAvailable && (input.balanceEnabled || input.balanceManual)) return 'balance';
  // 环境排在余额之后：它是用户主动查的一次性结果，但不如余额那种「实时花销」紧迫
  if (input.envOn && input.envAvailable) return 'env';
  if (input.workOn && input.workText && input.workStatusEnabled) return 'work';
  return 'none';
}

/**
 * 余额气泡的可翻页数。
 *
 * 页数规则归 shared（与每页内容同源），这里只补一个「还没有结果」的兜底。
 *
 * @param balance - 最近一次余额结果；`null` 表示这一拍还没有数据。
 * @returns 页数，至少 1。
 */
/** 点击编排默认队列（与 shared 的 DEFAULT_BUBBLE_CLICK_STEPS 同值；放这里避免再导一次常量）。 */
const DEFAULT_CLICK_STEPS: readonly BubbleClickStep[] = [{ kind: 'summary' }, { kind: 'detail' }, { kind: 'pricing' }];

export function balancePageCount(
  balance: BalanceState | null,
  pages: BubblePageOptions = {},
  steps: readonly BubbleClickStep[] = DEFAULT_CLICK_STEPS,
  whisperText: string | null = null,
  template?: readonly BubbleRowTemplate[],
): number {
  if (!balance || !balance.ok) return 1;
  if (balance.shape === 'custom') return balancePageCountOf(balance, pages);
  return clickPageCountOf(balance, steps, pages, whisperText, template);
}

/** 余额气泡组件；props 与 `client/bubble.ts` 的 BalanceBubble 一致。 */
export type BalanceBubbleComponent = (props: {
  state: BalanceState;
  on: boolean;
  index: number;
  onCycle: () => void;
}) => ReactNode;

/** 说话气泡组件；配图二选一，props 与 `client/bubble.ts` 的 WhisperBubble 一致。 */
export type WhisperBubbleComponent = (props: {
  text: string;
  image?: string;
  url?: string;
  assetRoot?: string;
  on: boolean;
  /** 可点时的回调；工作气泡用它跳会话，缺省即不可点。 */
  onClick?: (e: ReactNS.MouseEvent<HTMLDivElement>) => void;
  /** 戳破回调；只有说话气泡给，工作状态气泡给的是 onClick。 */
  onPop?: () => void;
}) => ReactNode;

/** 注入的 react 能力。 */
export interface BubbleSlotsRuntime {
  /** 创建元素。 */
  h: typeof jsx;
  /** 状态。 */
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  /** 引用。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  /** 副作用；用于卸载时清计时器。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}

/** 待办面板气泡组件；props 与 `client/todo-bubble.ts` 的 TodoBubble 一致。 */
export type TodoBubbleComponent = (props: { on: boolean; onClose: () => void }) => ReactNode;

/** 环境气泡组件；props 与 `client/bubble.ts` 的 EnvBubble 一致。 */
export type EnvBubbleComponent = (props: { state: EnvState; on: boolean }) => ReactNode;

/** 四种气泡组件。 */
export interface BubbleComponents {
  /** 余额气泡。 */
  balanceBubble: BalanceBubbleComponent;
  /** 环境气泡。 */
  envBubble: EnvBubbleComponent;
  /** 待办面板气泡。 */
  todoBubble: TodoBubbleComponent;
  /** 说话气泡。 */
  whisperBubble: WhisperBubbleComponent;
}

/** 每次渲染由 PetCard 提供的视图输入。 */
export interface BubbleSlotsInput {
  /** 最近一次余额结果。 */
  balance: BalanceState | null;
  /** 点击编排页设置（主页固定，明细/峰谷各一个开关）；缺省全开。 */
  bubblePages?: BubblePageOptions;
  /** 点击编排队列（来自配置 bubbleClickSteps）；缺省按 summary → detail → pricing。 */
  bubbleSteps?: readonly BubbleClickStep[];
  /** 自定义页模板（来自配置 bubbleTemplate）；队列里没有 custom 步骤时不使用。 */
  bubbleTemplate?: readonly BubbleRowTemplate[];
  /** 配置是否启用余额。 */
  balanceEnabled: boolean;
  /** 本次余额是否手动请求。 */
  balanceManual: boolean;
  /** 配置是否启用工作状态联动。 */
  workStatusEnabled: boolean;
  /** 工作状态是否处于终态。 */
  workTerminal: boolean;
  /** 工作状态是否在「等待确认」（ask_user_question 等人）。 */
  workWaiting: boolean;
  /** 当前展示条目所属会话；有值才把工作气泡做成可点。 */
  workSessionId?: string | null;
  /** 点工作气泡时跳过去；缺省即不可点（网页端直接切，桌面端由容器转发）。 */
  onFocusSession?: (sessionId: string) => void;
  /** 说话气泡配图的素材根。 */
  assetRoot?: string;
  /** 最近一次环境结果；只有 petId 与本宠物相符时容器才会传。 */
  env: EnvState | null;
}

/** 气泡单槽对外的读写面。 */
export interface BubbleSlots {
  /** 点亮余额气泡并回到第一页，重置停留计时。clicked=true 表示由点击宠物发起（优先级更高）。 */
  showBalance(clicked?: boolean): void;
  /** 点亮环境气泡，重置停留计时。 */
  showEnv(): void;
  /** 点余额气泡翻页，并重置停留计时。 */
  cycleBalance(): void;
  /** 点亮说话气泡；duration 为 0 时不改动当前气泡，undefined 用默认时长。 */
  showWhisper(text: string, parts: { image?: string; url?: string }, duration?: number): void;
  /** 收起说话气泡；不碰动画与另两种气泡。 */
  clearWhisper(): void;
  /** 更新工作气泡文本，显隐不动。 */
  updateWorkText(text: string | null): void;
  /** 点亮工作气泡；terminal 决定 10s 后自动收起，非终态常驻。 */
  lightWork(terminal: boolean): void;
  /** 收起工作气泡但保留文本。 */
  hideWork(): void;
  /** 回空闲：收起工作气泡并清文本。 */
  resetWork(): void;
  /** 打开待办面板：它独占槽位，其余气泡让位。 */
  showTodo(): void;
  /** 收起待办面板，按原优先级恢复其余气泡。 */
  hideTodo(): void;
  /** 开关待办面板：已开则收起，供快捷键使用。 */
  toggleTodo(): void;
  /** 按优先级渲染当前该挂的气泡；无气泡时为 null。 */
  node(): ReactNode;
}

/**
 * 制造气泡单槽的 hook，每个 PetCard 调一次。
 *
 * @param rt - 注入的 react 能力。
 * @param components - 余额与说话气泡组件。
 * @returns 接收视图输入的 hook；钩子内部的状态与计时器随卡片卸载一并清理。
 */
export function createBubbleSlots(rt: BubbleSlotsRuntime, components: BubbleComponents) {
  const { h, useState, useRef, useEffect } = rt;
  const BalanceBubble = components.balanceBubble;
  const EnvBubble = components.envBubble;
  const TodoBubble = components.todoBubble;
  const WhisperBubble = components.whisperBubble;

  return function useBubbleSlots(input: BubbleSlotsInput): BubbleSlots {
    // 余额气泡：显隐与展开页。
    const [balanceOn, setBalanceOn] = useState(false);
    const [balancePage, setBalancePage] = useState(0);
    // 这次余额气泡是否来自「点宠物本体」：点击编排要盖过任务状态与碎碎念（见 decideBubbleSlot）。
    const [balanceClicked, setBalanceClicked] = useState(false);
    const balanceTimerRef = useRef<number | null>(null);
    // 环境气泡：只有显隐，没有翻页（一屏放得下）。
    const [envOn, setEnvOn] = useState(false);
    const envTimerRef = useRef<number | null>(null);
    // 说话气泡：显隐、文本与配图（池内名与完整地址二选一）。收起时机在 bubbleHoldRef：
    // 语音合成期间挂起计时，播完再留一小段尾巴（见 shared/bubble-hold）。
    const [whisperOn, setWhisperOn] = useState(false);
    const [whisperText, setWhisperText] = useState<string | null>(null);
    const [whisperImage, setWhisperImage] = useState<string | undefined>(undefined);
    const [whisperUrl, setWhisperUrl] = useState<string | undefined>(undefined);
    const whisperHoldRef = useRef<BubbleHoldState>(BUBBLE_HOLD_IDLE);
    const whisperTextRef = useRef<string | null>(null);
    const whisperTimerRef = useRef<number | null>(null);
    // 待办面板：独占槽位，没有停留计时，显隐只由用户开关。
    const [todoOn, setTodoOn] = useState(false);
    // 工作状态气泡：显隐与文本。
    const [workOn, setWorkOn] = useState(false);
    const [workText, setWorkText] = useState<string | null>(null);
    const workTimerRef = useRef<number | null>(null);
    // 语音播报状态：只在手动触发的那一句上有值，气泡据此显示转圈 / 喇叭
    const [voiceState, setVoiceState] = useState<VoiceState>('idle');

    // 订阅是模块级单例：卸载时必须退订，否则旧卡片会被后续状态推送重渲染
    useEffect(() => subscribeVoiceState(setVoiceState), []);

    // 卸载后不再 setState：四个计时器都在这里清。
    useEffect(
      () => () => {
        if (balanceTimerRef.current !== null) window.clearTimeout(balanceTimerRef.current);
        if (envTimerRef.current !== null) window.clearTimeout(envTimerRef.current);
        if (whisperTimerRef.current !== null) window.clearTimeout(whisperTimerRef.current);
        if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
      },
      [],
    );

    /** 重置余额气泡的停留计时；重复触发先清旧定时器，否则旧的会提前收起。 */
    const armBalanceTimeout = () => {
      if (balanceTimerRef.current !== null) window.clearTimeout(balanceTimerRef.current);
      balanceTimerRef.current = window.setTimeout(() => {
        setBalanceOn(false);
        setBalanceClicked(false);
      }, BUBBLE_DURATION_MS);
    };

    const showBalance = (clicked = false) => {
      setBalancePage(0); // 新一轮查询从第一页开始。
      setBalanceClicked(clicked);
      setBalanceOn(true);
      armBalanceTimeout();
    };

    const cycleBalance = () => {
      const pages = balancePageCount(
        input.balance,
        input.bubblePages,
        input.bubbleSteps ?? DEFAULT_CLICK_STEPS,
        whisperText,
        input.bubbleTemplate,
      );
      setBalancePage((page) => (page + 1) % pages);
      // 重新计时：第 8 秒点开才剩 2 秒，看不清下一页。
      armBalanceTimeout();
    };

    // 点宠物本体：第一次显示第 0 页，之后逐页推进，末页再点收起（whale 挂件的冒泡编排手感）。
    // 这三个 ref 让订阅只建一次（订阅里读最新状态），否则每拍重订阅会漏事件。
    const balanceOnRef = useRef(false);
    const balancePageRef = useRef(0);
    const balanceStateRef = useRef<BalanceState | null>(null);
    // 编排设置会随配置热更新；订阅只建一次，所以用 ref 读最新值。
    const bubblePagesRef = useRef<BubblePageOptions>({});
    bubblePagesRef.current = input.bubblePages ?? {};
    const bubbleStepsRef = useRef<readonly BubbleClickStep[]>(DEFAULT_CLICK_STEPS);
    bubbleStepsRef.current = input.bubbleSteps ?? DEFAULT_CLICK_STEPS;
    // 自定义页模板同样随配置热更新，订阅只建一次所以也走 ref。
    const bubbleTemplateRef = useRef<readonly BubbleRowTemplate[] | undefined>(input.bubbleTemplate);
    bubbleTemplateRef.current = input.bubbleTemplate;
    // 碎碎念页要显示「最近一条」文案；同样用 ref，订阅只建一次。
    whisperTextRef.current = whisperText;
    useEffect(() => {
      balanceOnRef.current = balanceOn;
    }, [balanceOn]);
    useEffect(() => {
      balancePageRef.current = balancePage;
    }, [balancePage]);
    balanceStateRef.current = input.balance;
    useEffect(
      () =>
        subscribePetClicked(() => {
          const state = balanceStateRef.current;
          // 还没有余额结果（或明确不可用）：这一下只播点击动画，不弹空气泡。
          if (!state || !state.ok) return;
          if (!balanceOnRef.current) {
            showBalance(true);
            return;
          }
          const pages = balancePageCount(
            state,
            bubblePagesRef.current,
            bubbleStepsRef.current,
            whisperTextRef.current,
            bubbleTemplateRef.current,
          );
          if (balancePageRef.current + 1 >= pages) {
            setBalanceOn(false); // 末页再点 = 收起
            return;
          }
          cycleBalance();
        }),
      [],
    );

    /** 环境气泡：点一次亮一次，停留时长与余额相同；重复触发先清旧定时器。 */
    const showEnv = () => {
      setEnvOn(true);
      if (envTimerRef.current !== null) window.clearTimeout(envTimerRef.current);
      envTimerRef.current = window.setTimeout(() => {
        envTimerRef.current = null;
        setEnvOn(false);
      }, BUBBLE_DURATION_MS);
    };

    /** 推进说话气泡的收起计划，并按新计划重排计时器。 */
    const applyWhisperHold = (event: BubbleHoldEvent): void => {
      const next = reduceBubbleHold(whisperHoldRef.current, event);
      if (next === whisperHoldRef.current) return; // 同引用 = 无事发生，别白白重排计时器
      whisperHoldRef.current = next;
      setWhisperOn(next.on);
      if (whisperTimerRef.current !== null) window.clearTimeout(whisperTimerRef.current);
      whisperTimerRef.current = null;
      if (next.delayMs === null) return;
      whisperTimerRef.current = window.setTimeout(() => {
        whisperTimerRef.current = null;
        applyWhisperHold({ kind: 'hide' });
      }, next.delayMs);
    };

    // 语音报开始/结束时推进收起计划：合成慢的时候气泡得挂住，播完再收。
    // 只认文本相同的那一句——同一页面上的其他宠物共用这份模块单例状态。
    useEffect(
      () =>
        subscribeVoiceUtterance((event) => {
          if (event.text !== whisperTextRef.current) return;
          applyWhisperHold(utteranceToHold(event));
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 订阅只建一次：收起计划全部经 ref 现读，重订阅只会漏事件
      [],
    );

    const showWhisper = (text: string, parts: { image?: string; url?: string }, duration?: number) => {
      if (duration === 0) return; // 只联动动画、不改气泡时走这里。
      setWhisperText(text);
      whisperTextRef.current = text;
      setWhisperImage(parts.image);
      setWhisperUrl(parts.url);
      applyWhisperHold({ durationMs: duration ?? BUBBLE_DURATION_MS, kind: 'show' });
    };

    const clearWhisper = () => {
      whisperTextRef.current = null;
      setWhisperText(null);
      setWhisperImage(undefined);
      applyWhisperHold({ kind: 'clear' });
    };

    const lightWork = (terminal: boolean) => {
      setWorkOn(true);
      if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
      // 非终态常驻，不设自动收起。
      workTimerRef.current = terminal ? window.setTimeout(() => setWorkOn(false), BUBBLE_DURATION_MS) : null;
    };

    const hideWork = () => {
      if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
      workTimerRef.current = null;
      setWorkOn(false);
    };

    const resetWork = () => {
      hideWork();
      setWorkText(null);
    };

    const showTodo = (): void => setTodoOn(true);
    const hideTodo = (): void => setTodoOn(false);
    const toggleTodo = (): void => setTodoOn((on) => !on);

    const node = (): ReactNode => {
      const slot = decideBubbleSlot({
        todoOn,
        workTerminal: input.workTerminal,
        workOn,
        workText,
        workStatusEnabled: input.workStatusEnabled,
        whisperOn,
        whisperText,
        balanceOn,
        balanceAvailable: input.balance !== null,
        balanceEnabled: input.balanceEnabled,
        balanceManual: input.balanceManual,
        balanceClicked,
        workWaiting: input.workWaiting,
        envOn,
        envAvailable: input.env !== null,
      });
      if (slot === 'todo') return h(TodoBubble, { on: todoOn, onClose: hideTodo });
      if (slot === 'env') {
        return input.env === null ? null : h(EnvBubble, { state: input.env, on: envOn });
      }
      if (slot === 'balance') {
        return input.balance === null
          ? null
          : h(BalanceBubble, {
              state: input.balance,
              on: balanceOn,
              index: balancePage,
              onCycle: cycleBalance,
              pages: input.bubblePages ?? {},
              steps: input.bubbleSteps ?? DEFAULT_CLICK_STEPS,
              template: input.bubbleTemplate,
              whisperText,
            });
      }
      if (slot === 'whisper') {
        return whisperText === null
          ? null
          : h(WhisperBubble, {
              text: whisperText,
              image: whisperImage,
              url: whisperUrl,
              assetRoot: input.assetRoot,
              on: whisperOn,
              voiceState,
              // 戳破：动画播完由组件回调收起，只动气泡，不碰动画与另三种气泡。
              onPop: clearWhisper,
            });
      }
      // 终态与非终态共用同一个组件，差别只在停留时长与优先级。
      if (slot === 'work' || slot === 'work-terminal') {
        if (workText === null) return null;
        const sessionId = input.workSessionId ?? '';
        const onFocus = input.onFocusSession;
        // 拿不到会话就别做成可点：点下去没有任何去处，比不可点更糟。
        const onClick = sessionId !== '' && onFocus !== undefined ? () => onFocus(sessionId) : undefined;
        return h(WhisperBubble, {
          text: workText,
          on: workOn,
          ...(onClick === undefined ? {} : { onClick }),
        });
      }
      return null;
    };

    return {
      clearWhisper,
      cycleBalance,
      hideTodo,
      hideWork,
      lightWork,
      node,
      resetWork,
      showBalance,
      showEnv,
      showTodo,
      showWhisper,
      toggleTodo,
      updateWorkText: setWorkText,
    };
  };
}
