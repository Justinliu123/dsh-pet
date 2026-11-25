/**
 * 数据通道模式：插件只产出数据，不装碎碎念调度。
 *
 * 钉住「同一份宿主代码在 DSH 与独立版两边跑」时不会再各生成一份文案
 * （否则语音打开会念两遍、模型额度也被多烧一次）。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/loops-data-channel.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { registerLoops, type LoopsInput } from './loops.ts';

/** 只记录注册了哪些循环，不执行循环体（执行会读配置、起定时器、发网络请求）。 */
function fakeInput(labels: string[], overrides: Partial<LoopsInput> = {}): LoopsInput {
  const ctx = {
    effect(fn: () => void | (() => void), label?: string): () => void {
      labels.push(String(label ?? ''));
      void fn;
      return () => {};
    },
  };
  const base = {
    ctx,
    balancePeriodSec: () => 1800,
    configPaths: { defaultFile: '/x/config.jsonc', userFile: '/x/main-config.jsonc', petDir: '/x/pet' },
    lastWhisperAt: new Map<string, number>(),
    lock: { locked: () => false, acquire: () => true, release: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    publishWhisper: async () => {},
    refreshBalance: async () => {},
    sleep: { sleeping: () => false, isSleeping: () => false },
    standaloneAiPolicy: () => ({ ready: true }),
    whisperPeriodSec: () => 300,
  } as unknown as LoopsInput;
  return { ...base, ...overrides } as LoopsInput;
}

describe('registerLoops —— 数据通道模式', () => {
  test('独立版（不传 whisperDisabled）：只装余额与碎碎念两套循环，不装梦话循环', () => {
    const labels: string[] = [];
    registerLoops(fakeInput(labels));
    assert.deepEqual(labels, ['dsh-pet: balance poll', 'dsh-pet: whisper poll']);
  });

  test('插件数据通道（whisperDisabled=true）：不装碎碎念，仅保留余额循环', () => {
    const labels: string[] = [];
    registerLoops(fakeInput(labels, { whisperDisabled: true }));
    assert.deepEqual(labels, ['dsh-pet: balance poll']);
    assert.equal(labels.includes('dsh-pet: whisper poll'), false, '数据通道不得注册碎碎念调度');
  });

  test('whisperDisabled=false 与不传等价：仍然装', () => {
    const labels: string[] = [];
    registerLoops(fakeInput(labels, { whisperDisabled: false }));
    assert.equal(labels.includes('dsh-pet: whisper poll'), true);
  });
});
