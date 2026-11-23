/**
 * 桌面宠物判定（src/host/plugin/desktop/pets.ts）的契约测试。
 *
 * 三条契约：三个取值函数每次现读配置（改完文件下一次调用就生效，没有缓存与刷新）；
 * 读不出来按「没有桌面宠物、仍要托盘」降级且不抛；判定日志含宠物数与结论。
 * 桌宠只显示在桌面端：配置里的每一只宠物都进桌面窗，判定不再看显示位置。
 * 用真实临时配置文件驱动 readAllConfig，不 mock 配置层。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDesktopPets } from './plugin/desktop/pets.ts';
import { flattenPetList, readAllConfig, type ConfigPaths } from './config.ts';

/** 一只最小可用的宠物实例（合并后 size / position 都会被填满）。 */
const PET = (id: string, size: number): Record<string, unknown> => ({
  id,
  size,
  position: { corner: 'bottom-right', marginX: 24, marginY: 0 },
});

/** 最小可用配置：整段 animations 必须合法（合并是整段替换/整段回退）。 */
const baseConfig = (trayEnabled = true, pets: Array<Record<string, unknown>> = [PET('main', 200)]) => ({
  animations: {
    idle: ['idle1'],
    turn: ['turn1'],
    drag: ['drag1'],
    clicks: ['click1'],
    moves: { default: {}, actions: [] },
  },
  animationWeights: { idle: 100, turn: 0, move: 0 },
  eventsRefreshSec: {},
  pets,
  trayEnabled,
});

/** 建一套临时配置目录；返回路径、改写配置的入口与清理函数。 */
function fixture(initial: { trayEnabled?: boolean; pets?: Array<Record<string, unknown>> }): {
  paths: ConfigPaths;
  write: (next: { trayEnabled?: boolean; pets?: Array<Record<string, unknown>> }) => void;
  writeRaw: (raw: string) => void;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-desktop-pets-'));
  const paths: ConfigPaths = {
    defaultFile: join(dir, 'default.jsonc'),
    userFile: join(dir, 'main-config.jsonc'),
    petDir: join(dir, 'pet'),
  };
  writeFileSync(paths.defaultFile, JSON.stringify(baseConfig(initial.trayEnabled, initial.pets)));
  return {
    paths,
    write: (next) => writeFileSync(paths.defaultFile, JSON.stringify(baseConfig(next.trayEnabled, next.pets))),
    writeRaw: (raw) => writeFileSync(paths.defaultFile, raw),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 静默 logger（被测模块只用到 info/warn，其余成员在用例里无意义）。 */
const quietLog = { info: () => {}, warn: () => {} } as unknown as Parameters<typeof createDesktopPets>[0]['log'];

describe('createDesktopPets —— 判定必须现读配置', () => {
  test('配置里一只宠物都没有：判定为无桌面宠物', () => {
    const f = fixture({ pets: [] });
    try {
      const pets = createDesktopPets({ configPaths: f.paths, effectivePetList: () => [], log: quietLog });
      assert.equal(pets.getHasDesktopPet(), false);
    } finally {
      f.cleanup();
    }
  });

  test('配置里有宠物：判定为有桌面宠物（桌宠只显示在桌面端，每一只都进桌面窗）', () => {
    const f = fixture({});
    try {
      const pets = createDesktopPets({ configPaths: f.paths, effectivePetList: () => [], log: quietLog });
      assert.equal(pets.getHasDesktopPet(), true);
    } finally {
      f.cleanup();
    }
  });

  test('createDesktopPets 之后改配置：下一次调用立刻读到新值（不需要任何刷新）', () => {
    const f = fixture({ pets: [] });
    try {
      const pets = createDesktopPets({ configPaths: f.paths, effectivePetList: () => [], log: quietLog });
      assert.equal(pets.getHasDesktopPet(), false, '前提：配置里还没有宠物');

      f.write({ pets: [PET('main', 200)] });
      assert.equal(pets.getHasDesktopPet(), true, '没有缓存：加一只宠物后下一次调用就该是 true');
    } finally {
      f.cleanup();
    }
  });

  test('删掉最后一只宠物同样立刻生效', () => {
    const f = fixture({});
    try {
      const pets = createDesktopPets({ configPaths: f.paths, effectivePetList: () => [], log: quietLog });
      assert.equal(pets.getHasDesktopPet(), true);
      f.write({ pets: [] });
      assert.equal(pets.getHasDesktopPet(), false);
    } finally {
      f.cleanup();
    }
  });

  test('桌面窗列表 = 配置里的全部宠物：增删与改 size 都跟着变', () => {
    const f = fixture({ pets: [PET('main', 200), PET('second', 300)] });
    try {
      const pets = createDesktopPets({
        configPaths: f.paths,
        effectivePetList: () => flattenPetList(readAllConfig(f.paths)),
        log: quietLog,
      });
      assert.deepEqual(pets.desktopPetList(), [
        { id: 'main', size: 200 },
        { id: 'second', size: 300 },
      ]);

      f.write({ pets: [PET('main', 500)] });
      assert.deepEqual(
        pets.desktopPetList(),
        [{ id: 'main', size: 500 }],
        '改 size 与删一只都要立刻反映到桌面窗参数上',
      );
    } finally {
      f.cleanup();
    }
  });

  test('托盘开关同样读当前值', () => {
    const f = fixture({ trayEnabled: true });
    try {
      const pets = createDesktopPets({ configPaths: f.paths, effectivePetList: () => [], log: quietLog });
      assert.equal(pets.getTrayOn(), true);
      f.write({ trayEnabled: false });
      assert.equal(pets.getTrayOn(), false);
    } finally {
      f.cleanup();
    }
  });

  test('配置读不出来：按「没有桌面宠物、仍要托盘」降级，不抛', () => {
    const f = fixture({});
    try {
      const pets = createDesktopPets({ configPaths: f.paths, effectivePetList: () => [], log: quietLog });
      f.writeRaw('{ 这不是 JSON');
      assert.equal(pets.getHasDesktopPet(), false, '读不出来宁可不 spawn');
      assert.equal(pets.getTrayOn(), true, '保守保留托盘');
      assert.deepEqual(pets.desktopPetList(), []);
    } finally {
      f.cleanup();
    }
  });

  test('logDesktopDecision 打一行判定日志，含宠物数与结论', () => {
    const f = fixture({ trayEnabled: false });
    try {
      const lines: string[] = [];
      const log = { info: (line: string) => lines.push(line), warn: () => {} } as unknown as Parameters<
        typeof createDesktopPets
      >[0]['log'];
      const pets = createDesktopPets({ configPaths: f.paths, effectivePetList: () => [], log });
      assert.equal(lines.length, 1, '装配时先打一行');
      pets.logDesktopDecision();
      assert.equal(lines.length, 2);
      const line = lines[1];
      assert.ok(line.includes('pets=1（main）'), line);
      assert.ok(line.includes('hasDesktopPet=true'), line);
      assert.ok(line.includes('tray=false'), line);
    } finally {
      f.cleanup();
    }
  });
});
