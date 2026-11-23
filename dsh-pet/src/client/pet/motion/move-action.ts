/**
 * 一次自主走位的规划：选动作、算方向与距离、交给共享层的 `planMove` 判可达性。
 * 距离按宠物尺寸等比缩放（`minDist`/`maxDist` 是基准宽度下的像素），越界就返回 `null` 让调用方退回原地动作。
 * 纯规划：占用判定（rAF 是否在跑）留在调用方，因为那是 ref 状态。
 * @module dsh-pet/src/client/pet/motion/move-action
 */
import { planMove, planLeanSpot, type MovePlan } from '../../../shared/motion.ts';
import { PET_REF_WIDTH } from '../../../shared/constants.ts';
import type { MovesConfig } from '../../../shared/types.ts';

/** 一次待执行的走位：几何比例 + 方向与首尾留白（秒）。 */
export interface PendingMove extends MovePlan {
  /** 1 = 向右，-1 = 向左。 */
  dir: 1 | -1;
  /** 动作开头多少秒内不位移（起脚）。 */
  leadSec: number;
  /** 动作结尾多少秒前就到位（收脚）。 */
  tailSec: number;
}

/** 靠边停靠走位的请求：只说「靠哪边、扒在哪」，几何由驱动现取。 */
export interface LeanRequest {
  /** 该宠物的走位池：借里面的走路动作（与普通走位同一套）。 */
  moves: MovesConfig;
  /** 靠哪一侧的边。 */
  side: 'left' | 'right';
  /** 扒的那条竖线在画幅里的横向位置（0~1）。 */
  anchorX: number;
  /** 随机源，默认 `Math.random`；注入以便测试。 */
  random?: () => number;
}

/** 靠边停靠走位的完整输入：请求 + 当帧几何。 */
export interface LeanMoveInput extends LeanRequest {
  /** 宠物盒宽（px）。 */
  size: number;
  /** 当前宠物中心（px）。 */
  center: { x: number; y: number };
  /** 视口尺寸（px）。 */
  viewport: { width: number; height: number };
  /** 盒的半宽。 */
  halfW: number;
  /** 身体相对视频盒左右各留的像素（透明边）。 */
  sideAllow: number;
}

/** 离落点太近就不去：已经贴着边了，再走一趟等于原地重播靠边（站直又扒下去）。 */
const MIN_LEAN_DIST_RATIO = 0.5;

/** 规划输入。 */
export interface MoveActionInput {
  /** 该宠物的走位池。 */
  moves: MovesConfig;
  /** 菜单点播指定的动作名；缺省随机。 */
  preferredName?: string;
  /** 当前朝向，决定走位方向。 */
  facing: 'left' | 'right';
  /** 宠物宽度（px）。 */
  size: number;
  /** 当前宠物中心（px）。 */
  center: { x: number; y: number };
  /** 视口尺寸（px）。 */
  viewport: { width: number; height: number };
  /** 盒的半宽。 */
  halfW: number;
  /** 身体相对视频盒左右各留的像素（透明边）。 */
  sideAllow: number;
  /** 随机源，默认 `Math.random`；注入以便测试。 */
  random?: () => number;
}

/** 规划结果：`null` = 没有可用动作或落点越界。 */
export interface MoveAction {
  /** 要播的走位动作名。 */
  anim: string;
  /** 待执行的走位（rAF 驱动时才消费）。 */
  pending: PendingMove;
}

/**
 * 规划一次自主走位。
 *
 * @param input - 走位池、朝向、尺寸与视口。
 * @returns 动作名与待执行走位；无法移动时返回 `null`。
 */
export function planMoveAction(input: MoveActionInput): MoveAction | null {
  const actions = input.moves.actions;
  if (actions.length === 0) return null;
  const random = input.random ?? Math.random;
  const chosen = input.preferredName
    ? (actions.find((action) => action.name === input.preferredName) ?? null)
    : actions[Math.floor(random() * actions.length)];
  if (!chosen) return null;
  const params = Object.assign({}, input.moves.default, chosen.params ?? {});
  // 走路方向只看当前 facing；不要用 turn 动画反推方向。
  const dir: 1 | -1 = input.facing === 'right' ? 1 : -1;
  // 移动距离随宠物缩放：基准尺寸下的 px 按 size / PET_REF_WIDTH 等比放大。
  const distScale = input.size / PET_REF_WIDTH;
  const plan = planMove({
    cx: input.center.x,
    cy: input.center.y,
    W: input.viewport.width,
    H: input.viewport.height,
    dir,
    minDist: params.minDist * distScale,
    maxDist: params.maxDist * distScale,
    margin: params.margin,
    halfW: input.halfW,
    sideAllow: input.sideAllow,
  });
  if (plan === null) return null;
  return { anim: chosen.name, pending: { ...plan, dir, leadSec: params.leadSec, tailSec: params.tailSec } };
}

/**
 * 规划一次「冲着屏幕边线去」的走位（靠边停靠用）。
 *
 * 与 {@link planMoveAction} 的区别只有落点：普通走位是随机距离，这里固定停在
 * 「扒的那条竖线正好压在屏幕边线」的位置。距离超过走位池的上限（一步走不到）时返回 null——
 * 这一趟不去，等宠物下次离边更近时再说。
 *
 * @param input - 走位池、靠边一侧、锚点与当前位置。
 * @returns 动作名与待执行走位；走不到时返回 `null`。
 */
export function planLeanMove(input: LeanMoveInput): MoveAction | null {
  const actions = input.moves.actions;
  if (actions.length === 0) return null;
  const random = input.random ?? Math.random;
  const chosen = actions[Math.floor(random() * actions.length)];
  if (!chosen) return null;
  const params = Object.assign({}, input.moves.default, chosen.params ?? {});
  const target = planLeanSpot({
    W: input.viewport.width,
    size: input.size,
    sideAllow: input.sideAllow,
    anchorX: input.anchorX,
    side: input.side,
  });
  if (target === null) return null;
  // 走位池的距离上限就是「一步能走多远」：太远这一趟不去。
  const distScale = input.size / PET_REF_WIDTH;
  const dist = Math.abs(target - input.center.x);
  if (dist < input.size * MIN_LEAN_DIST_RATIO) return null;
  if (dist > params.maxDist * distScale) return null;
  const plan: MovePlan = {
    startRatio: input.center.x / input.viewport.width,
    startYRatio: input.center.y / input.viewport.height,
    targetRatio: target / input.viewport.width,
    totalRatio: dist / input.viewport.width,
  };
  const dir: 1 | -1 = input.side === 'right' ? 1 : -1;
  return { anim: chosen.name, pending: { ...plan, dir, leadSec: params.leadSec, tailSec: params.tailSec } };
}
