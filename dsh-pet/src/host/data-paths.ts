/**
 * 数据根与桥目录：插件与独立应用各用各的数据根，桥文件放机器级共享目录。
 *
 * 为什么这样分：
 * - 独立应用要能装到别的电脑上（便携版把数据放 exe 同目录的 `data\`），不能把自己绑在 DSH 的数据根下；
 * - 插件在 DSH 里跑，数据根跟着 DSH 走，但它已瘦成「只做数据通道」，那份配置只影响数据源本身；
 * - 桥描述文件与存活心跳是**两个进程**之间的约定，既不属于插件数据根也不属于应用数据根，
 *   放机器级共享目录才不会因为一侧换目录而失联。
 *
 * 只算路径，不读盘、不判断存在性；目录是否已存在由调用方决定（`../host/paths.ts` 管包内素材路径）。
 * @module dsh-pet/src/host/data-paths
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * 数据根环境变量：独立应用（exe / CLI）启动时把便携数据根写进来，进程内宿主半侧据此落配置与日志。
 * 插件在 DSH 里不设它，于是回落到 `<DSH 数据根>/dsh-pet`。
 */
export const DATA_ROOT_ENV = 'DSH_PET_DATA_ROOT';

/** 目录名：DSH 数据根下与便携数据根都叫这个名字，读日志时一眼能认。 */
export const PET_DIR_NAME = 'dsh-pet';

/**
 * 解析桌宠数据根。
 *
 * @param fallbackHome - 没有显式数据根时的父目录（插件传 DSH 数据根，例如 `~/.dsh`）。
 * @returns 已 resolve 的绝对目录；不保证存在（调用方按需 mkdir）。
 */
export function petDataRoot(fallbackHome: string): string {
  const fromEnv = process.env[DATA_ROOT_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(fallbackHome, PET_DIR_NAME);
}

/**
 * 桥目录：机器级共享。插件写 `standalone-bridge.json`，独立应用写 `standalone-running.json`。
 *
 * Windows 用 `%APPDATA%`，其余平台回落 `~/.config`（这里只放「发现」用的文件，不存用户数据）。
 */
export function bridgeDir(): string {
  const appData = process.env.APPDATA;
  const base = typeof appData === 'string' && appData.trim() !== '' ? appData : join(homedir(), '.config');
  return join(base, PET_DIR_NAME, 'bridge');
}
