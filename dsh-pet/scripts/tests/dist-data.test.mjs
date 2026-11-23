/**
 * 打包时搬运便携数据目录（scripts/dist-data.mjs）的单测。
 *
 * 关注两件事：打包重建解包目录后用户数据能原样回来；密钥文件的权限被收紧到当前用户
 * （输出目录继承的是安装目录的宽权限，宽权限的密钥文件会被应用拒绝加载）。
 * 跑法：node --test scripts/tests/dist-data.test.mjs（npm run test:ui 会带上）。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { backupPortableData, discardPortableDataBackup, restorePortableData } from '../dist-data.mjs';

/**
 * 建一个临时目录当解包目录，并放一份带密钥文件的便携数据目录。
 *
 * @param t - 测试上下文；用于在断言失败时也把临时目录清掉。
 * @returns 临时目录、解包目录与数据目录。
 */
function scratchWithData(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pet-dist-data-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const unpackedDir = join(base, 'win-unpacked');
  const dataDir = join(unpackedDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'main-config.jsonc'), '{ "bubbleClickSteps": [] }');
  writeFileSync(join(dataDir, 'standalone-ai.json'), '{ "keys": { "MINIMAX_CN_API_KEY": "sk-test" } }');
  writeFileSync(join(dataDir, 'spend.json'), '{}');
  return { base, unpackedDir, dataDir };
}

/** 给文件加上「所有人可读」的宽权限，模拟安装目录继承来的 ACL。 */
function grantEveryoneRead(path) {
  execFileSync('icacls', [path, '/grant', '*S-1-5-11:(R)'], { stdio: 'pipe', windowsHide: true });
}

/** 读文件的 ACL 条目文本。 */
function aclText(path) {
  return execFileSync('icacls', [path], { encoding: 'utf8', windowsHide: true });
}

describe('打包搬运便携数据目录', () => {
  test('备份：数据目录的内容原样进备份目录', (t) => {
    const { base, unpackedDir } = scratchWithData(t);
    const backupDir = backupPortableData(unpackedDir, base);
    assert.ok(backupDir, '有数据目录时应产出备份');
    assert.equal(
      readFileSync(join(backupDir, 'data', 'standalone-ai.json'), 'utf8'),
      '{ "keys": { "MINIMAX_CN_API_KEY": "sk-test" } }',
    );
    assert.equal(readFileSync(join(backupDir, 'data', 'main-config.jsonc'), 'utf8'), '{ "bubbleClickSteps": [] }');
  });

  test('备份：没有数据目录时不产出备份', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-pet-dist-data-test-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const unpackedDir = join(base, 'win-unpacked');
    mkdirSync(unpackedDir, { recursive: true });
    assert.equal(backupPortableData(unpackedDir, base), undefined);
  });

  test('还原：解包目录被重建后，数据目录回到原处', (t) => {
    const { base, unpackedDir } = scratchWithData(t);
    const backupDir = backupPortableData(unpackedDir, base);
    rmSync(join(unpackedDir, 'data'), { recursive: true, force: true });
    const restored = restorePortableData(unpackedDir, backupDir);
    assert.equal(restored, join(unpackedDir, 'data'));
    assert.equal(
      readFileSync(join(restored, 'standalone-ai.json'), 'utf8'),
      '{ "keys": { "MINIMAX_CN_API_KEY": "sk-test" } }',
    );
    assert.ok(existsSync(join(restored, 'spend.json')));
  });

  test('还原：重建期间留在数据目录里的旧文件不残留', (t) => {
    const { base, unpackedDir } = scratchWithData(t);
    const backupDir = backupPortableData(unpackedDir, base);
    writeFileSync(join(unpackedDir, 'data', 'stale.json'), '{}');
    const restored = restorePortableData(unpackedDir, backupDir);
    assert.equal(existsSync(join(restored, 'stale.json')), false, '还原是整份覆盖，不与残留文件混合');
  });

  test('还原：密钥文件的权限被收紧到当前用户', { skip: process.platform !== 'win32' }, (t) => {
    const { base, unpackedDir, dataDir } = scratchWithData(t);
    grantEveryoneRead(join(dataDir, 'standalone-ai.json'));
    const backupDir = backupPortableData(unpackedDir, base);
    rmSync(join(unpackedDir, 'data'), { recursive: true, force: true });
    const restored = restorePortableData(unpackedDir, backupDir);
    const acl = aclText(join(restored, 'standalone-ai.json'));
    assert.doesNotMatch(acl, /Everyone|Authenticated Users|BUILTIN\\Users/i, `密钥文件权限仍过宽：\n${acl}`);
  });

  test('清理：备份目录删干净，不把用户配置留在临时目录', (t) => {
    const { base, unpackedDir } = scratchWithData(t);
    const backupDir = backupPortableData(unpackedDir, base);
    discardPortableDataBackup(backupDir);
    assert.equal(existsSync(backupDir), false);
  });
});
