/**
 * 轮询循环的单元测试：睡觉期间不再注册梦话（sleepTalk）循环，避免睡眠时后台调用模型。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/loops.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { registerLoops, type LoopsInput } from './loops.ts';

describe('registerLoops —— 睡觉不触发后台梦话循环', () => {
  test('不注册 sleep talk 定时循环', () => {
    const labels: string[] = [];
    const input = {
      ctx: {
        effect(fn: () => void | (() => void), label?: string): () => void {
          labels.push(String(label ?? ''));
          void fn;
          return () => {};
        },
      },
      balancePeriodSec: () => 1800,
      configPaths: { defaultFile: '/x/config.jsonc', userFile: '/x/main-config.jsonc', petDir: '/x/pet' },
      lastWhisperAt: new Map<string, number>(),
      lock: { locked: () => false, acquire: () => true, release: () => {} },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      publishWhisper: async () => {},
      refreshBalance: async () => {},
      sleep: { sleeping: () => true, ids: () => ['main'] },
      standaloneAiPolicy: () => ({ isReady: () => true }),
      whisperPeriodSec: () => 300,
    } as unknown as LoopsInput;
    registerLoops(input);
    assert.equal(
      labels.some((label) => label.includes('sleep talk')),
      false,
      '睡觉期间不得注册梦话定时循环',
    );
  });
});
