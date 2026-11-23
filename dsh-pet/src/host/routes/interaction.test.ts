/**
 * 会话交互路由（src/host/routes/interaction.ts）中 /whisper 的契约测试：
 * ?image= 透传给生成函数、语音目标不再由路由指定、缺省不带、失败 reason 原样透出。
 * 锁 / 投喂 / 清气泡三个分支各有自己的覆盖，这里只钉住 /whisper 这一条链路。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { handleInteractionRoutes } from './interaction.ts';
import { VOICE_TARGET } from '../voice-target.ts';
import type { GeneratedReply, PetRouteDeps, RouteInput } from './types.ts';

/** 造一份只满足 /whisper 分支的依赖：宠物定位恒命中，生成行为由调用方给。 */
function harness(whisper: (petId: string, image?: string) => Promise<GeneratedReply>) {
  // extra 记 publishWhisper 除 (petId, image) 之外还收到了什么参数：语音目标不再由路由指定，
  // 这里要能看见它确实一个都没传。
  const calls: { petId: string; image?: string; extra: unknown[] }[] = [];
  const deps = {
    requirePet: () => ({ ok: true, petId: 'main', entry: 'main', conf: {}, pet: {} }),
    publishWhisper: (petId: string, image?: string, ...extra: unknown[]) => {
      calls.push({ petId, image, extra });
      return whisper(petId, image);
    },
  } as unknown as PetRouteDeps;
  const call = (query: string) =>
    handleInteractionRoutes(deps, {
      url: new URL('http://127.0.0.1/dsh-pet-7340/whisper' + query),
      rest: 'whisper',
      method: 'POST',
    } as RouteInput);
  return { calls, call };
}

describe('handleInteractionRoutes —— /whisper 的语音目标（恒为桌面端）', () => {
  test('路由不再指定语音目标：由宿主统一（VOICE_TARGET 恒为 desktop）', async () => {
    // 桌宠只显示在桌面端，这一句就只由桌面端念——语音目标是宿主层的一个常量，
    // 路由不再按调用方挑一端，也就不会再往下游传语音目标。
    const probe = harness(async () => ({ ok: true, text: '好' }));
    await probe.call('?pet=main');
    assert.deepEqual(probe.calls[0]?.extra, [], '路由不该再往下游指定语音目标');
    assert.equal(VOICE_TARGET, 'desktop', '语音播给哪一端恒为桌面端');
  });

  test('surface 参数被忽略：传什么都一样，谁来念不受影响', async () => {
    for (const want of ['web', 'desktop', 'both', 'any', 'nope']) {
      const probe = harness(async () => ({ ok: true, text: '好' }));
      await probe.call('?pet=main&surface=' + want);
      assert.deepEqual(probe.calls[0]?.extra, [], `surface=${want} 不该影响语音目标`);
    }
  });
});

describe('handleInteractionRoutes —— /whisper 的指定配图', () => {
  test('带 ?image=：图名原样交给生成函数，成功应答照旧带回文本与图', async () => {
    const { calls, call } = harness(async (_petId, image) => ({ ok: true, text: '好呀', image }));
    const result = await call('?pet=main&image=' + encodeURIComponent('大的要来啦'));
    assert.deepEqual(calls, [{ petId: 'main', image: '大的要来啦', extra: [] }], '图名必须原样透传，不解码错位');
    assert.equal((result as { obj: { image?: string } }).obj.image, '大的要来啦');
  });

  test('不带 ?image=：生成函数收到 undefined（随机/纯文本那条老路径）', async () => {
    const { calls, call } = harness(async () => ({ ok: true, text: '好呀' }));
    await call('?pet=main');
    assert.deepEqual(calls, [{ petId: 'main', image: undefined, extra: [] }]);
  });

  test('图不在池内：unknown-image 原样透出，不糊成 generate-error', async () => {
    const { call } = harness(async () => ({ ok: false, reason: 'unknown-image', message: '表情包不在池内：查无此图' }));
    const result = await call('?pet=main&image=' + encodeURIComponent('查无此图'));
    const body = (result as { status: number; obj: { ok: boolean; reason?: string } }).obj;
    assert.equal((result as { status: number }).status, 200, '业务失败沿用「HTTP 200 + 失败实体」');
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'unknown-image', '调用方按 reason 分支，不能被归一化掉');
  });
});
