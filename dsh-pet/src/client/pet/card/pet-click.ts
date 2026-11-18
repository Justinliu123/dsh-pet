/**
 * 宠物本体点击的模块级广播：拖拽层在「点击」分支发，气泡层据此显示或推进编排气泡。
 *
 * 用广播而不是层层传回调，是因为拖拽层与气泡层之间隔着 PetCard 与容器：
 * 两边都在同一个客户端里，模型统一后加一个订阅比串一串 props 更不容易漏改。
 * 订阅方自己判状态（有没有余额结果、气泡是否已亮），广播本身不做任何判定。
 *
 * @module dsh-pet/src/client/pet/card/pet-click
 */

/** 点击回调：无参数，状态由订阅方从自己的 ref 里现读。 */
type PetClickListener = () => void;

/** 当前所有订阅者；模块级单例，客户端同一页面里只有一个宠物气泡槽会订阅。 */
const listeners = new Set<PetClickListener>();

/**
 * 广播一次「宠物本体被点击」。
 *
 * 遍历副本：回调里退订（例如卡片卸载）不会影响本次派发。
 */
export function notifyPetClicked(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * 订阅宠物本体点击。
 *
 * @param listener - 点击时调用；返回的退订函数必须在卡片卸载时执行。
 * @returns 退订函数。
 */
export function subscribePetClicked(listener: PetClickListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
