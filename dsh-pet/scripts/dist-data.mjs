/**
 * 打包时搬运便携数据目录：electron-builder 重建解包目录时会连同 `data\` 一起删掉，
 * 用户的配置、AI 密钥、花费账本与日志都在里面。
 * 备份落在系统临时目录（跨盘符也能拷）；还原时把密钥文件的权限收紧到当前用户——
 * 输出目录继承的是安装目录的宽权限，宽权限的密钥文件会被应用拒绝加载。
 * 不负责调用 electron-builder（见 ./dist.mjs）。
 * @module dsh-pet/scripts/dist-data
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 便携数据目录名：独立应用把配置、密钥、账本与日志放在 exe 同级。 */
const DATA_DIR_NAME = 'data';

/** 权限必须收紧的文件：应用读它之前会拒绝「权限过宽」的密钥文件。 */
const SECRET_FILE_NAME = 'standalone-ai.json';

/**
 * 备份便携数据目录。
 *
 * @param unpackedDir - 解包目录（win-unpacked）。
 * @param backupRoot - 备份根目录；缺省用系统临时目录。
 * @returns 备份目录路径；没有数据目录时返回 undefined。
 */
export function backupPortableData(unpackedDir, backupRoot = tmpdir()) {
  const dataDir = join(unpackedDir, DATA_DIR_NAME);
  if (!existsSync(dataDir)) return undefined;
  const backupDir = mkdtempSync(join(backupRoot, 'dsh-pet-dist-data-'));
  copyDirContents(dataDir, join(backupDir, DATA_DIR_NAME));
  return backupDir;
}

/**
 * 把备份的数据目录放回解包目录。
 *
 * 整份替换而不是合并：备份才是用户状态的权威，
 * 留着重建期间冒出来的文件会变成新旧混搭（半旧半新的配置最难排查）。
 *
 * @param unpackedDir - 解包目录（win-unpacked）。
 * @param backupDir - {@link backupPortableData} 返回的备份目录。
 * @returns 还原后的数据目录路径。
 */
export function restorePortableData(unpackedDir, backupDir) {
  const target = join(unpackedDir, DATA_DIR_NAME);
  rmSync(target, { recursive: true, force: true });
  copyDirContents(join(backupDir, DATA_DIR_NAME), target);
  tightenToCurrentUser(join(target, SECRET_FILE_NAME));
  return target;
}

/**
 * 删掉备份目录。
 *
 * @param backupDir - 备份目录。
 */
export function discardPortableDataBackup(backupDir) {
  rmSync(backupDir, { recursive: true, force: true });
}

/**
 * 逐项复制目录内容：copyFileSync 不带安全描述符，落地文件的权限随目标目录继承。
 *
 * @param source - 源目录。
 * @param target - 目标目录（不存在则创建）。
 */
function copyDirContents(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(from, to);
      continue;
    }
    copyFileSync(from, to);
  }
}

/**
 * 把文件权限收紧到当前用户：输出目录继承的是安装目录的宽权限，
 * 宽权限的密钥文件会被应用按「权限不可信」拒绝加载。
 *
 * @param path - 目标文件；不存在时什么都不做。
 */
function tightenToCurrentUser(path) {
  if (!existsSync(path)) return;
  if (process.platform !== 'win32') {
    execFileSync('chmod', ['600', path]);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const identity = execFileSync(join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('Cannot identify file owner');
  execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`], {
    stdio: 'pipe',
    windowsHide: true,
  });
}
