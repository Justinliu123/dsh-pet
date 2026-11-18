/**
 * 宿主入口描述文件与公布逻辑：独立桌宠靠它发现 DSH（端口随机，扫端口不可靠）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  announceDshBridge,
  bridgeDescriptorPath,
  normalizeBridgeOrigin,
  parseBridgeDescriptor,
  readBridgeDescriptor,
  removeBridgeDescriptor,
  writeBridgeDescriptor,
} from './bridge-descriptor.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-bridge-'));
}

test('写入后可读回，入口尾斜杠被规范化', () => {
  const dir = tempRoot();
  try {
    const written = writeBridgeDescriptor(dir, 'http://127.0.0.1:52195/');
    assert.equal(written.origin, 'http://127.0.0.1:52195');
    const read = readBridgeDescriptor(dir);
    assert.deepEqual(read, written);
    // 落盘是带换行的可读 JSON（便于排障手看）
    const raw = readFileSync(bridgeDescriptorPath(dir), 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.equal(JSON.parse(raw).origin, 'http://127.0.0.1:52195');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非法入口不写（宿主 bug 要显式抛错，不能写一份没人能用的文件）', () => {
  const dir = tempRoot();
  try {
    assert.throws(() => writeBridgeDescriptor(dir, 'not-a-url'), /无效的宿主入口/);
    assert.throws(() => writeBridgeDescriptor(dir, 'file:///c:/tmp'), /无效的宿主入口/);
    assert.equal(existsSync(bridgeDescriptorPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏 JSON、缺字段、版本不认识一律当「没有桥」', () => {
  const dir = tempRoot();
  try {
    writeFileSync(bridgeDescriptorPath(dir), '{oops', 'utf8');
    assert.equal(readBridgeDescriptor(dir), undefined);
    writeFileSync(bridgeDescriptorPath(dir), JSON.stringify({ version: 2, origin: 'http://127.0.0.1:1', pid: 1 }), 'utf8');
    assert.equal(readBridgeDescriptor(dir), undefined);
    assert.equal(parseBridgeDescriptor({ version: 1, origin: 'http://127.0.0.1:1' }), undefined);
    assert.equal(parseBridgeDescriptor(null), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('清理只删自己那份：宿主重启后新描述不能被旧进程删掉', () => {
  const dir = tempRoot();
  try {
    writeBridgeDescriptor(dir, 'http://127.0.0.1:1000', { pid: 111 });
    writeBridgeDescriptor(dir, 'http://127.0.0.1:2000', { pid: 222 });
    removeBridgeDescriptor(dir, 111);
    assert.equal(readBridgeDescriptor(dir)?.origin, 'http://127.0.0.1:2000');
    removeBridgeDescriptor(dir, 222);
    assert.equal(readBridgeDescriptor(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeBridgeOrigin 只放行 http(s)', () => {
  assert.equal(normalizeBridgeOrigin(' http://127.0.0.1:8080 '), 'http://127.0.0.1:8080');
  assert.equal(normalizeBridgeOrigin('https://example.com/path'), 'https://example.com');
  assert.equal(normalizeBridgeOrigin('ftp://example.com'), undefined);
  assert.equal(normalizeBridgeOrigin(''), undefined);
  assert.equal(normalizeBridgeOrigin(42), undefined);
});

test('独立应用不公布入口（伪 webServer 没有 getOrigin），宿主才公布并在卸载时清理', () => {
  const dir = tempRoot();
  const previousAppMode = process.env.DSH_PET_APP_MODE;
  try {
    // 独立应用：有 webServer，但只有 port / register
    assert.equal(
      announceDshBridge({
        ctx: { webServer: {} },
        userRoot: dir,
        log: { info() {} },
      }),
      undefined,
    );

    // 宿主：getOrigin 给出真实入口，公布后独立应用可读
    const disposers: Array<() => void> = [];
    const messages: string[] = [];
    const descriptor = announceDshBridge({
      ctx: {
        webServer: { getOrigin: () => 'http://127.0.0.1:52195' },
        effect: (callback: () => (() => void) | void, label: string) => {
          assert.equal(label, 'dsh-pet: bridge descriptor');
          const disposer = callback();
          if (disposer !== undefined) disposers.push(disposer);
        },
      },
      userRoot: dir,
      log: { info: (message: string) => messages.push(message) },
    });
    assert.equal(descriptor?.origin, 'http://127.0.0.1:52195');
    assert.equal(readBridgeDescriptor(dir)?.origin, 'http://127.0.0.1:52195');
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes('DSH 桥已公布宿主入口'));

    for (const dispose of disposers) dispose();
    assert.equal(readBridgeDescriptor(dir), undefined);
  } finally {
    if (previousAppMode === undefined) delete process.env.DSH_PET_APP_MODE;
    else process.env.DSH_PET_APP_MODE = previousAppMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('独立模式环境变量下即使有 getOrigin 也不公布', () => {
  const dir = tempRoot();
  const previous = process.env.DSH_PET_APP_MODE;
  try {
    process.env.DSH_PET_APP_MODE = '1';
    const descriptor = announceDshBridge({
      ctx: { webServer: { getOrigin: () => 'http://127.0.0.1:52195' } },
      userRoot: dir,
      log: { info() {} },
    });
    assert.equal(descriptor, undefined);
    assert.equal(readBridgeDescriptor(dir), undefined);
  } finally {
    if (previous === undefined) delete process.env.DSH_PET_APP_MODE;
    else process.env.DSH_PET_APP_MODE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
