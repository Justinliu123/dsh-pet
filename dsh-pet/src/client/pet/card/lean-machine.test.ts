/**
 * 靠边停靠状态机（src/client/pet/card/lean-machine.ts）的契约测试。
 *
 * 四条契约：进入先 start（once）再 loop（无限播）；保持段被外来动画顶掉后必须重新点名 loop；
 * 离开播 end 再交回随机链一次；被拖走时放弃靠边但不播任何动画。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createLeanMachine } from './lean-machine.ts';
import type { CardHub } from './hub.ts';
import type { LeanSide } from '../../../shared/types.ts';

/** 一侧的靠边素材：三段各一个名字，外加扒的那条竖线在画幅里的位置。 */
const RIGHT_SET: LeanSide = {
  start: ['靠边-开始-右'],
  loop: ['靠边-循环-右'],
  end: ['靠边-结束-右'],
  anchorX: 0.53,
};

/** 造一套只记录换源调用的运行时；本模块用不到的卡片成员按类型断言补空。 */
function harness() {
  const calls: string[] = [];
  let anim = '待机呼吸休闲';
  let once = true;
  let facing = 'right';
  const hub = {
    cfg: () => ({ id: 'pet-1' }),
    card: {
      facingRef: { current: 'right' },
      actions: {
        setAnim: (next: string) => {
          anim = next;
          calls.push('anim:' + next);
        },
        setOnce: (next: boolean) => {
          once = next;
          calls.push('once:' + next);
        },
        setFacing: (next: string) => {
          facing = next;
          calls.push('facing:' + next);
        },
        bumpSeq: () => calls.push('seq'),
      },
    },
    stopMotion: () => calls.push('stopMotion'),
  } as unknown as CardHub;
  return { hub, calls, anim: () => anim, once: () => once, facing: () => facing };
}

/** 造状态机；handedBack 记录交回随机链的次数。 */
function setup(hub: CardHub) {
  let handedBack = 0;
  const lean = createLeanMachine(
    hub,
    () => {
      handedBack += 1;
    },
    () => {},
  );
  return { lean, handedBack: () => handedBack };
}

describe('lean-machine —— 进入与保持', () => {
  test('进入靠边：停走位、按成朝左、先播 start（只播一次）', () => {
    const { hub, calls, anim, once, facing } = harness();
    const { lean } = setup(hub);

    lean.enter('right', RIGHT_SET);

    assert.deepEqual(calls, ['stopMotion', 'facing:left', 'once:true', 'anim:靠边-开始-右', 'seq']);
    assert.equal(anim(), '靠边-开始-右');
    assert.equal(once(), true, '过渡段只播一次，播完要接保持段');
    assert.equal(facing(), 'left', '素材本身画的是往哪侧扒，朝向要按成 left 才不会被镜像掰反');
    assert.equal(lean.leaning(), true);
    assert.equal(lean.phase(), 'start');
    assert.equal(lean.side(), 'right');
  });

  test('start 播完：切 loop（无限播），ended 归状态机处理', () => {
    const { hub, calls, anim, once } = harness();
    const { lean, handedBack } = setup(hub);
    lean.enter('right', RIGHT_SET);
    calls.length = 0;

    assert.equal(lean.consumeEnded(), true, 'start 播完归状态机处理，不回随机链');

    assert.equal(anim(), '靠边-循环-右');
    assert.equal(once(), false, '保持段必须无限播，否则 ended 会落回状态机');
    assert.equal(lean.phase(), 'loop');
    assert.equal(handedBack(), 0);
  });

  test('保持段被外来动画顶掉：ended 后重新点名 loop，而不是重播前台', () => {
    const { hub, calls, anim, once } = harness();
    const { lean } = setup(hub);
    lean.enter('right', RIGHT_SET);
    lean.consumeEnded();
    // 顶替现场：显式点播直接换源（once=true），保持段被顶掉，那段播完就会 ended。
    hub.card.actions.setAnim('余额-钱袋如常');
    hub.card.actions.setOnce(true);
    calls.length = 0;

    assert.equal(lean.consumeEnded(), true);

    assert.equal(anim(), '靠边-循环-右', '应该重新点名保持段，而不是重播当前前台');
    assert.equal(once(), false, '拉回保持段后要恢复无限播');
  });

  test('已在靠边时再进一次：不重播过渡段', () => {
    const { hub, calls } = harness();
    const { lean } = setup(hub);
    lean.enter('right', RIGHT_SET);
    calls.length = 0;

    lean.enter('right', RIGHT_SET);

    assert.deepEqual(calls, [], '叶子重写一次不该重置播放进度');
  });
});

describe('lean-machine —— 离开与放弃', () => {
  test('离开靠边：播 end，播完交回随机链一次', () => {
    const { hub, anim, once } = harness();
    const { lean, handedBack } = setup(hub);
    lean.enter('right', RIGHT_SET);
    lean.consumeEnded();

    lean.exit();

    assert.equal(anim(), '靠边-结束-右');
    assert.equal(once(), true, '离开过渡只播一次');
    assert.equal(lean.phase(), 'end');

    assert.equal(lean.consumeEnded(), true);
    assert.equal(handedBack(), 1, 'end 播完应该恰回随机链一次');
    assert.equal(lean.leaning(), false);
    assert.equal(lean.phase(), null);
  });

  test('没在靠边时离开：幂等空操作，ended 交回调用方', () => {
    const { hub, calls } = harness();
    const { lean, handedBack } = setup(hub);

    lean.exit();

    assert.deepEqual(calls, []);
    assert.equal(lean.consumeEnded(), false, '不在靠边时 ended 交回调用方按常规处理');
    assert.equal(handedBack(), 0);
  });

  test('被拖走：放弃靠边但不播任何动画', () => {
    const { hub, calls } = harness();
    const { lean, handedBack } = setup(hub);
    lean.enter('right', RIGHT_SET);
    lean.consumeEnded();
    calls.length = 0;

    lean.abandon();

    assert.deepEqual(calls, [], '宠物已经被拖离屏幕边线，没必要再播站直段');
    assert.equal(lean.leaning(), false);
    assert.equal(lean.phase(), null);
    assert.equal(handedBack(), 0, '放弃不交回随机链：拖拽路径自己收尾');
  });

  test('已经在离开段时再放弃：清掉状态，不重播', () => {
    const { hub, calls } = harness();
    const { lean } = setup(hub);
    lean.enter('right', RIGHT_SET);
    lean.consumeEnded();
    lean.exit();
    calls.length = 0;

    lean.abandon();

    assert.deepEqual(calls, []);
    assert.equal(lean.leaning(), false);
  });
});

describe('lean-machine —— 三段多候选', () => {
  /** 多候选的一套：三段各两个名字。 */
  const MULTI_SET: LeanSide = {
    start: ['靠边-开始-甲', '靠边-开始-乙'],
    loop: ['靠边-循环-甲', '靠边-循环-乙'],
    end: ['靠边-结束-甲', '靠边-结束-乙'],
    anchorX: 0.666,
  };

  /** 临时替换 Math.random，返回还原函数。 */
  function stubRandom(value: number): () => void {
    const original = Math.random;
    Math.random = () => value;
    return () => {
      Math.random = original;
    };
  }

  test('进入时抽 start 候选之一，播完抽 loop 候选之一', () => {
    const restore = stubRandom(0.9); // 0.9 * 2 = 1.8 → 取下标 1
    try {
      const { hub, anim } = harness();
      const { lean } = setup(hub);

      lean.enter('right', MULTI_SET);
      assert.equal(anim(), '靠边-开始-乙', 'start 段多候选应随机抽一个');

      lean.consumeEnded();
      assert.equal(anim(), '靠边-循环-乙', 'loop 段多候选应随机抽一个');
    } finally {
      restore();
    }
  });

  test('保持段被顶掉后换另一个 loop 候选，不重播刚才那个', () => {
    const { hub, anim } = harness();
    const { lean } = setup(hub);
    // 第一次抽中「甲」：random=0.1 → 0.1*2=0.2 → 下标 0
    const restore = stubRandom(0.1);
    try {
      lean.enter('right', MULTI_SET);
      lean.consumeEnded();
      assert.equal(anim(), '靠边-循环-甲');

      // 被顶掉后重点名：排除当前那个 → 池里只剩「乙」
      Math.random = () => 0.9;
      assert.equal(lean.consumeEnded(), true);
      assert.equal(anim(), '靠边-循环-乙', '保持段多候选应换一个，而不是重播刚才那个');
    } finally {
      restore();
    }
  });

  test('离开时抽 end 候选之一', () => {
    const restore = stubRandom(0.1);
    try {
      const { hub, anim } = harness();
      const { lean } = setup(hub);
      lean.enter('right', MULTI_SET);
      lean.consumeEnded();

      lean.exit();
      assert.equal(anim(), '靠边-结束-甲');
    } finally {
      restore();
    }
  });
});
