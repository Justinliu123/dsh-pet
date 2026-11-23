import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { createStandaloneContext } from '../standalone/context.ts';
import { listenStandaloneServer, type StandaloneServer } from '../standalone/server.ts';
import { createRequestSecurity } from '../standalone/request-security.ts';
import { readUserConfig } from './config.ts';

// 把真实 host 打包进临时包，让它的 assets 能解析，同时不改动 src/assets。
const source = fileURLToPath(new URL('..', import.meta.url));
const pet = (id: string) => ({
  id,
  name: id,
  size: 240,
  balanceEnabled: false,
  whisperEnabled: false,
  workStatusEnabled: false,
  position: { corner: 'top-right', marginX: 20, marginY: 20 },
});
let dir = '';
let file = '';
let packFile = '';
let pigFile = '';
let base = '';
let token = '';
let context: ReturnType<typeof createStandaloneContext>;
let server: StandaloneServer;
const previousHome = process.env.DSH_HOME;
const previousInProcess = process.env.DSH_PET_IN_PROCESS;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-config-concurrency-'));
  const pkg = join(dir, 'package');
  mkdirSync(join(pkg, 'assets'), { recursive: true });
  copyFileSync(new URL('../../assets/config.jsonc', import.meta.url), join(pkg, 'assets/config.jsonc'));
  const aliases = Object.fromEntries(
    ['dsh-home-paths', 'dsh-credentials', 'dsh-llm'].map((name) => [
      '@deepseek-ai/' + name,
      join(source, 'standalone/shims', name + '.ts'),
    ]),
  );
  const bundle = await rolldown({
    input: join(source, 'host/index.ts'),
    platform: 'node',
    external: (id) =>
      id.startsWith('node:') ||
      (id.startsWith('@deepseek-ai/') && !(id in aliases)) ||
      ['zod', '@electron/get', '@electron-internal/extract-zip', '@andresaya/edge-tts'].includes(id),
    plugins: [{ name: 'standalone-test-shims', resolveId: (id) => aliases[id] }],
  });
  const entry = join(pkg, 'lib/host.mjs');
  await bundle.write({ format: 'esm', file: entry });
  await bundle.close();
  const home = join(dir, 'home');
  process.env.DSH_HOME = home;
  process.env.DSH_PET_IN_PROCESS = '1';
  mkdirSync(join(home, 'dsh-pet/pet'), { recursive: true });
  file = join(home, 'dsh-pet/main-config.jsonc');
  packFile = join(home, 'dsh-pet/pet/pack-config.jsonc');
  pigFile = join(home, 'dsh-pet/pet/pig-config.jsonc');
  writeFileSync(file, JSON.stringify({ trayEnabled: false, pets: [pet('alpha'), pet('beta')] }));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  context = createStandaloneContext({ port: 0, logger });
  const { apply } = await import(pathToFileURL(entry).href);
  apply(context.ctx);
  assert.deepEqual(context.failures, []);
  const security = createRequestSecurity();
  token = security.token;
  server = await listenStandaloneServer({ routes: context.routes, logger, port: 0, security });
  base = `http://127.0.0.1:${server.port}/dsh-pet-7340/`;
});

beforeEach(() => {
  writeFileSync(
    file,
    JSON.stringify({ trayEnabled: false, notificationsEnabled: true, pets: [pet('alpha'), pet('beta')] }),
  );
  rmSync(packFile, { force: true });
  rmSync(pigFile, { force: true });
});

after(async () => {
  await server?.close();
  await context?.dispose();
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  if (previousInProcess === undefined) delete process.env.DSH_PET_IN_PROCESS;
  else process.env.DSH_PET_IN_PROCESS = previousInProcess;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { 'X-DSH-Pet-Token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      main?: { pets: Array<{ id: string }> };
      pack?: unknown;
      reason?: string;
    },
  };
}

const read = (path = file) => {
  const value = readUserConfig({ userFile: path, defaultFile: '', petDir: '' });
  assert.ok(value, 'the saved config must remain readable');
  return value as { pets: ReturnType<typeof pet>[]; [key: string]: unknown };
};
/** 取某一层落盘的宠物 id 列表（按顺序）：并发写之后两只都得还在。 */
const ids = (value: { pets: Array<{ id: string }> }) => value.pets.map((p) => p.id);

test('concurrent write-backs keep both kinds of pets', async () => {
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a'), pet('pack-b')] }));
  writeFileSync(pigFile, JSON.stringify({ pets: [pet('pig-a')] }));
  const results = await Promise.all([
    request('pet-config', 'POST', { entry: 'pack', pets: [pet('pack-a'), pet('pack-b')] }),
    request('pet-config', 'POST', { entry: 'pig', pets: [pet('pig-a'), pet('pig-b')] }),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.main));
  assert.deepEqual(ids(read(packFile)), ['pack-a', 'pack-b'], 'pack 那份写回不得丢');
  assert.deepEqual(ids(read(pigFile)), ['pig-a', 'pig-b'], 'pig 那份写回不得丢');
});

test('concurrent pack write-back preserves pack pets and custom fields', async () => {
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a'), pet('pack-b')], whisperPrompt: 'keep this persona' }));
  const results = await Promise.all([
    request('pet-config', 'POST', { entry: 'pack', pets: [pet('pack-a'), pet('pack-b')] }),
    request('config', 'PUT', { pets: [pet('alpha'), pet('beta')] }),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.main));
  assert.deepEqual(ids(read(packFile)), ['pack-a', 'pack-b'], 'pack 两只都得在');
  assert.equal(read(packFile).whisperPrompt, 'keep this persona', '条目人设要保留');
  assert.deepEqual(ids(read()), ['alpha', 'beta'], 'main 层不受 pack 写回影响');
});

test('concurrent pack write and settings save do not overwrite each other', async () => {
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a')], whisperPrompt: 'keep this persona' }));
  const results = await Promise.all([
    request('config', 'PUT', { pets: [pet('alpha'), pet('beta')], notificationsEnabled: false }),
    request('pet-config', 'POST', { entry: 'pack', pets: [pet('pack-a'), pet('pack-b')] }),
  ]);
  assert.ok(
    results.every((r) => r.status === 200 && r.body.main),
    '两条写端点都要成功，且响应都是成品聚合',
  );
  assert.deepEqual(
    read().pets.map((p: { id: string }) => p.id),
    ['alpha', 'beta'],
    '设置页保存的 main 实例不得被种类写回覆盖',
  );
  assert.equal(read().notificationsEnabled, false, '全局字段不得被种类写回覆盖');
  assert.deepEqual(
    read(packFile).pets.map((p: { id: string }) => p.id),
    ['pack-a', 'pack-b'],
    '种类写回的结果不得被设置页保存覆盖',
  );
  assert.equal(read(packFile).whisperPrompt, 'keep this persona', '条目人设要保留');
});

test('a write-back cannot undo a concurrent settings save', async () => {
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a')] }));
  const results = await Promise.all([
    request('config', 'PUT', { pets: [pet('alpha'), pet('beta')], notificationsEnabled: false }),
    request('pet-config', 'POST', { entry: 'pack', pets: [pet('pack-a'), pet('pack-b')] }),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.main));
  assert.equal(read().notificationsEnabled, false, '设置保存的结果不得被并发写回撤销');
  assert.deepEqual(ids(read()), ['alpha', 'beta'], 'main 的实例列表不得被并发写回撤销');
});

test('restoring defaults cannot be undone by a concurrent write-back', async () => {
  writeFileSync(
    file,
    JSON.stringify({ trayEnabled: false, pets: [pet('main'), pet('extra')], note: 'remove on reset' }),
  );
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a')] }));
  const results = await Promise.all([
    request('pet-config', 'POST', { entry: 'pack', pets: [pet('pack-a'), pet('pack-b')] }),
    request('config', 'POST'),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.main));
  assert.equal(read().note, undefined, '恢复默认的结果不得被并发写回撤销');
  assert.deepEqual(ids(read()), ['main'], '恢复默认后 main 只剩内置那一只');
  assert.deepEqual(ids(read(packFile)), ['pack-a', 'pack-b'], '并发写回自己也不该丢');
});

test('config reads do not observe an incomplete concurrent save', async () => {
  const results = await Promise.all([
    request('config', 'PUT', { pets: [pet('alpha'), pet('beta')] }),
    ...Array.from({ length: 8 }, () => request('config')),
  ]);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.ok(result.body.main);
    assert.deepEqual(
      result.body.main.pets.map((p: { id: string }) => p.id),
      ['alpha', 'beta'],
    );
  }
});

test('a rejected config operation does not prevent later updates', async () => {
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a')] }));
  const invalid = await request('pet-config', 'POST', { entry: 'pack' });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.reason, 'bad-request', '缺 pets 的请求体必须被拒');
  assert.deepEqual(ids(read(packFile)), ['pack-a'], '被拒的请求不得写盘');
  const valid = await request('pet-config', 'POST', { entry: 'pack', pets: [pet('pack-a'), pet('pack-b')] });
  assert.equal(valid.status, 200);
  assert.deepEqual(ids(read(packFile)), ['pack-a', 'pack-b']);
});
