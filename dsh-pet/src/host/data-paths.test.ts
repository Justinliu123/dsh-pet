/**
 * 数据根与桥目录的解析规则：便携版靠环境变量改数据根，桥文件永远在机器级共享目录。
 *
 * 跑法：node --experimental-strip-types --test src/host/data-paths.test.ts
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { bridgeDir, DATA_ROOT_ENV, petDataRoot } from './data-paths.ts';

const saved = process.env[DATA_ROOT_ENV];
const savedAppData = process.env.APPDATA;

afterEach(() => {
  if (saved === undefined) delete process.env[DATA_ROOT_ENV];
  else process.env[DATA_ROOT_ENV] = saved;
  if (savedAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = savedAppData;
});

describe('petDataRoot —— 数据根', () => {
  test('没有环境变量时落在 <fallbackHome>/dsh-pet（插件在 DSH 里的形态）', () => {
    delete process.env[DATA_ROOT_ENV];
    assert.equal(petDataRoot('/home/u/.dsh'), join('/home/u/.dsh', 'dsh-pet'));
  });

  test('环境变量优先且被规范化成绝对路径（便携版 exe 的 data\\）', () => {
    process.env[DATA_ROOT_ENV] = '  D:/apps/dsh-pet/data  ';
    assert.equal(petDataRoot('/home/u/.dsh'), resolve('D:/apps/dsh-pet/data'));
  });

  test('空环境变量按未设置处理，不返回空目录', () => {
    process.env[DATA_ROOT_ENV] = '   ';
    assert.equal(petDataRoot('/home/u/.dsh'), join('/home/u/.dsh', 'dsh-pet'));
  });
});

describe('bridgeDir —— 桥目录', () => {
  test('Windows 用 %APPDATA%\\dsh-pet\\bridge', () => {
    process.env.APPDATA = 'C:/Users/u/AppData/Roaming';
    assert.equal(bridgeDir(), join('C:/Users/u/AppData/Roaming', 'dsh-pet', 'bridge'));
  });

  test('没有 APPDATA 时回落 ~/.config（Linux/mac 也能发现彼此）', () => {
    delete process.env.APPDATA;
    assert.equal(bridgeDir(), join(homedir(), '.config', 'dsh-pet', 'bridge'));
  });

  test('不受数据根环境变量影响：两边数据根不同也要读同一个桥目录', () => {
    process.env.APPDATA = 'C:/Users/u/AppData/Roaming';
    process.env[DATA_ROOT_ENV] = 'D:/apps/dsh-pet/data';
    assert.equal(bridgeDir(), join('C:/Users/u/AppData/Roaming', 'dsh-pet', 'bridge'));
  });
});
