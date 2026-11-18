/**
 * 日志兜底发现：描述文件缺席时从 DSH 日志尾部认回环入口。
 *
 * 纯解析 + 带缓存的解析器；读盘行为既用真实临时文件，也用注入的假日志验证缓存/静默。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDshEndpointResolver, lastDshOrigin, newestDshLog, readTail } from './dsh-endpoint.ts';

test('lastDshOrigin：取最后一次公布的入口，并归一化为 origin', () => {
  const text = [
    '[info] dsh desktop listening',
    '[info] dsh web: http://127.0.0.1:52195/?token=****',
    '[warn] 旧入口已失效',
    '[info] dsh web: http://127.0.0.1:53637/?token=****',
  ].join('\n');
  assert.equal(lastDshOrigin(text), 'http://127.0.0.1:53637');
});

test('lastDshOrigin：没有入口行或地址不可信时返回 undefined', () => {
  assert.equal(lastDshOrigin('nothing here'), undefined);
  assert.equal(lastDshOrigin('dsh web: ftp://127.0.0.1:1/'), undefined);
});

test('readTail：只读尾部字节，不把整份日志读进内存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-tail-'));
  try {
    const file = join(dir, 'desktop-next.log');
    writeFileSync(file, `${'x'.repeat(400)}\ndsh web: http://127.0.0.1:1234/?token=****\n`);
    const tail = readTail(file, 44);
    assert.ok(tail.includes('dsh web: http://127.0.0.1:1234/'));
    assert.ok(!tail.includes('xxxxxxxx'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('newestDshLog：只认 desktop-next* 日志并取 mtime 最新的一份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-logfind-'));
  try {
    const oldLog = join(dir, 'desktop-next.log');
    const newLog = join(dir, 'desktop-next-2026-11-18.0.log');
    const other = join(dir, 'other.log');
    writeFileSync(oldLog, 'old');
    writeFileSync(newLog, 'new');
    writeFileSync(other, 'other');
    const past = new Date('2026-11-18T09:00:00Z');
    const later = new Date('2026-11-18T10:00:00Z');
    utimesSync(oldLog, past, past);
    utimesSync(newLog, later, later);
    utimesSync(other, new Date('2026-11-18T11:00:00Z'), new Date('2026-11-18T11:00:00Z'));
    assert.equal(newestDshLog(dir), newLog);
    assert.equal(newestDshLog(join(dir, 'nope')), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDshEndpointResolver：缓存 TTL 内不重读，过期重读，invalidate 后静默再读', () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-pet-endpoint-'));
  try {
    const logs = join(dshHome, 'logs');
    mkdirSync(logs);
    const file = join(logs, 'desktop-next.log');
    writeFileSync(file, 'dsh web: http://127.0.0.1:1234/?token=****\n');

    let now = 1_000_000;
    let reads = 0;
    const resolver = createDshEndpointResolver({
      dshHome,
      now: () => now,
      tailReader: (target) => {
        reads += 1;
        return readTail(target);
      },
      logFinder: newestDshLog,
    });

    assert.equal(resolver.resolve(), 'http://127.0.0.1:1234');
    assert.equal(reads, 1);
    assert.equal(resolver.resolve(), 'http://127.0.0.1:1234');
    assert.equal(reads, 1, '缓存有效期内不应重读日志');

    writeFileSync(file, 'dsh web: http://127.0.0.1:5678/?token=****\n');
    now += 10_000;
    assert.equal(resolver.resolve(), 'http://127.0.0.1:5678');
    assert.equal(reads, 2);

    resolver.invalidate();
    assert.equal(resolver.resolve(), undefined, 'invalidate 后应有短暂静默');
    now += 5_000;
    assert.equal(resolver.resolve(), 'http://127.0.0.1:5678');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('createDshEndpointResolver：没有日志目录时返回 undefined 且不抛', () => {
  const resolver = createDshEndpointResolver({ dshHome: join(tmpdir(), 'dsh-pet-no-such-home') });
  assert.equal(resolver.resolve(), undefined);
});
