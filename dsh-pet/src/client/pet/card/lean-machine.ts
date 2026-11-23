/**
 * 靠边停靠状态机：把宿主写定的一套三段名翻译成动画链上的动作，并在扒边期间替随机链把关。
 *
 * 只管「播哪一段、到哪一步」；播完判定由 animation-flow 转交本模块的 consumeEnded()，
 * 离开靠边后回随机链由调用方传入的 pickNext 决定。不依赖 React。
 * 三段各是候选数组，进入该段时随机抽 1（单候选时就是它自己）。
 * 不变量：进入必须先播 start（once）再切 loop（无限播）；循环段没有 ended——
 * 收到就说明前台已被别的动画顶掉，必须重新点名 loop，而不是重播前台。
 * 扒边期间朝向被按成 left：素材本身画的就是往哪一侧扒，镜像会把方向掰反。
 * @module dsh-pet/src/client/pet/card/lean-machine
 */
import type { CardHub } from './hub.ts';
import type { LeanSide } from '../../../shared/types.ts';
import { pick } from '../../../shared/pickers.ts';

/** 靠边阶段：`start` 扒边过渡、`loop` 扒边保持、`end` 离开靠边。 */
export type LeanPhase = 'start' | 'loop' | 'end';

/** 靠哪一侧的边。 */
export type LeanSideName = 'left' | 'right';

/** 状态机对外面：进入 / 离开 / 查询。 */
export interface LeanMachine {
  /** 进入靠边：播 start（once），播完接 loop。已在靠边时是幂等空操作。 */
  enter(side: LeanSideName, set: LeanSide): void;
  /** 离开靠边：播 end（once），播完回随机链。不在靠边时是幂等空操作。 */
  exit(): void;
  /** 放弃靠边（被拖走之类）：清掉状态但不播动画——宠物已经不在边上了，没必要再站直。 */
  abandon(): void;
  /** 播完判定：返回 true = 这次 ended 归靠边管，调用方直接 return；false = 按常规处理。 */
  consumeEnded(): boolean;
  /** 此刻是否在靠边（含扒边与离开两段过渡）。 */
  leaning(): boolean;
  /** 当前阶段；没靠边为 null。 */
  phase(): LeanPhase | null;
  /** 当前靠哪一侧；没靠边为 null。 */
  side(): LeanSideName | null;
}

/**
 * 造靠边停靠状态机。
 *
 * @param hub - 卡片共享运行时（取动画写入口与朝向）。
 * @param pickNext - 离开靠边后回到随机链的动作（由动画流提供，避免本模块反向 import）。
 * @param log - 一行日志出口（格式与动画流一致）。
 */
export function createLeanMachine(
  hub: CardHub,
  pickNext: () => void,
  log: (petId: string, message: string) => void,
): LeanMachine {
  /** 当前这一趟：靠哪一侧、播哪三段、走到哪一步、当前保持段播的是哪个。 */
  let current: { side: LeanSideName; set: LeanSide; phase: LeanPhase; loopName: string } | null = null;

  /** 换一段：`once` 决定播完是否触发 ended（保持段必须 false）。 */
  const play = (name: string, once: boolean): void => {
    hub.card.actions.setOnce(once);
    hub.card.actions.setAnim(name);
    hub.card.actions.bumpSeq();
  };

  const enter = (side: LeanSideName, set: LeanSide): void => {
    if (current !== null) return; // 已在靠边：叶子重写一次不该从头再播
    const petId = hub.cfg().id;
    hub.stopMotion();
    // 三段各是候选数组：进入该段时随机抽 1（单候选时就是它自己）。
    const startName = pick(set.start);
    current = { side, set, phase: 'start', loopName: '' };
    // 朝向按成 left：靠边素材画的是「往右扒」或「往左扒」，镜像会把方向掰反。
    hub.card.facingRef.current = 'left';
    hub.card.actions.setFacing('left');
    log(petId, '靠边 ' + side + ' -> [' + startName + ']');
    play(startName, true);
  };

  const exit = (): void => {
    if (current === null || current.phase === 'end') return;
    const petId = hub.cfg().id;
    current.phase = 'end';
    const endName = pick(current.set.end);
    log(petId, '离开靠边 -> [' + endName + ']');
    play(endName, true);
  };

  const abandon = (): void => {
    if (current === null) return;
    log(hub.cfg().id, '放弃靠边（被拖走）');
    current = null;
  };

  return {
    enter,
    exit,
    abandon,
    consumeEnded: (): boolean => {
      if (current === null) return false;
      if (current.phase === 'start') {
        current.phase = 'loop';
        current.loopName = pick(current.set.loop);
        play(current.loopName, false); // 保持段：不触发 ended
        return true;
      }
      if (current.phase === 'loop') {
        // 扒边期间前台可能被外来动画顶掉（显式点播、hostInstruction）：ended 落到这里说明现在
        // 播的不是保持段。只重播前台会把顶进来的那段一次性动画续成死循环，必须重新点名保持段。
        // 多候选时换一个（避开刚被顶掉前在播的那个），单候选时还是它自己。
        current.loopName = pick(current.set.loop, current.loopName);
        play(current.loopName, false);
        return true;
      }
      // phase === 'end'：离开过渡播完，交回随机链
      current = null;
      pickNext();
      return true;
    },
    leaning: (): boolean => current !== null,
    phase: (): LeanPhase | null => current?.phase ?? null,
    side: (): LeanSideName | null => current?.side ?? null,
  };
}
