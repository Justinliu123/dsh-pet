/**
 * 桌面托盘的行为契约（runtime/electron-helper/main/tray.js）。
 *
 * 三条行为必须成立：菜单里只有「退出」一项（桌宠只显示在桌面端，托盘不再列出宠物）；
 * 退出项按运行形态决定自己退还是交给宿主；托盘开关关掉就不建托盘。
 * 依赖全由调用方注入（含 Electron 的 Tray/Menu/nativeImage），所以这里不需要真的 Electron。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/** 托盘模块是给 Helper 用的 CJS，没有类型声明：这里按用到的形状窄化。 */
interface TrayModule {
  createTray(deps: Record<string, unknown>): {
    start(): Promise<void>;
    refresh(): Promise<void>;
    exists(): boolean;
    destroy(): void;
  };
}

/** 一条菜单项：只断言用到的字段。 */
interface MenuItem {
  label: string;
  type?: string;
  checked?: boolean;
  click?: () => void;
}

const { createTray } = createRequire(import.meta.url)('../../runtime/electron-helper/main/tray.js') as TrayModule;

/** 造一套假依赖：记录宿主请求、菜单模板与退出调用。 */
function harness(options: {
  appMode?: boolean;
  isBridge?: boolean;
  canQuit?: boolean;
  trayEnabled?: boolean;
  pets?: Array<Record<string, unknown>>;
}) {
  const requests: string[] = [];
  const bodies: string[] = [];
  const quits: string[] = [];
  const menus: MenuItem[][] = [];

  class FakeTray {
    setToolTip(): void {}
    setContextMenu(menu: unknown): void {
      menus.push((menu as { template: MenuItem[] }).template);
    }
    on(): void {}
    popUpContextMenu(): void {}
    destroy(): void {}
  }

  const deps = {
    app: { quit: () => quits.push('app.quit') },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template: MenuItem[]) => ({ template }) },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false, resize: () => ({ setTemplateImage: () => {} }) }),
    },
    hostRequest: async (method: string, url: string, body?: string) => {
      requests.push(method + ' ' + url);
      if (body !== undefined) bodies.push(body);
      if (url.endsWith('/config')) {
        return {
          status: 200,
          body: JSON.stringify({
            main: { pets: options.pets ?? [], trayEnabled: options.trayEnabled !== false },
          }),
        };
      }
      if (url.endsWith('/quit')) {
        return { status: 200, body: JSON.stringify({ canQuit: options.canQuit === true }) };
      }
      return { status: 200, body: '{}' };
    },
    callbackUrl: () => 'http://127.0.0.1:1/bridge',
    isBridge: options.isBridge ?? false,
    appMode: options.appMode ?? false,
    petRoute: '/dsh-pet-7340',
    platform: { templateImage: false, leftClickPopsMenu: false },
    helperDir: '.',
  };

  const tray = createTray(deps);
  return { tray, requests, bodies, quits, menus };
}

/** 取最后一次构建出来的菜单模板。 */
function lastMenu(menus: MenuItem[][]): MenuItem[] {
  const menu = menus[menus.length - 1];
  assert.ok(menu, '托盘应已构建出菜单');
  return menu;
}

describe('createTray —— 菜单里只有退出', () => {
  test('菜单里只有「退出」一项：不再列出宠物，也没有勾选项', async () => {
    const { tray, menus } = harness({
      pets: [
        { label: 'a', id: 'a' },
        { label: 'b', id: 'b' },
      ],
    });
    await tray.start();
    const items = lastMenu(menus);
    assert.deepEqual(
      items.map((item) => item.label),
      ['退出'],
      '托盘不再承担「把宠物送到别处」：菜单里只有退出',
    );
    assert.equal(
      items.some((item) => item.type === 'checkbox'),
      false,
      '不再有按显示位置勾选的开关项',
    );
  });

  test('托盘不再写回显示位置：点退出前不发任何写请求', async () => {
    const { tray, requests } = harness({
      pets: [{ label: 'a', id: 'a' }],
    });
    await tray.start();
    assert.equal(
      requests.some((request) => !request.startsWith('GET ')),
      false,
      '建菜单只读配置，不写回任何配置',
    );
    assert.equal(
      requests.some((request) => request.includes('pet-display')),
      false,
      '显示位置写回端点已不存在，托盘也不再发它',
    );
  });
});

describe('createTray —— 退出项的分支', () => {
  test('应用模式：自己 app.quit()，不请求宿主', async () => {
    const { tray, menus, quits, requests } = harness({
      appMode: true,
      pets: [{ label: 'a', id: 'a' }],
    });
    await tray.start();
    const quit = lastMenu(menus).find((item) => item.label === '退出');
    assert.ok(quit?.click, '应用模式必须有退出项');
    quit.click();
    assert.deepEqual(quits, ['app.quit']);
    assert.equal(
      requests.some((request) => request.startsWith('POST') && request.endsWith('/quit')),
      false,
    );
  });

  test('bridge 且宿主允许：把退出交给宿主（自己退会被当成崩溃重启）', async () => {
    const { tray, menus, quits, requests } = harness({
      isBridge: true,
      canQuit: true,
      pets: [{ label: 'a', id: 'a' }],
    });
    await tray.start();
    const quit = lastMenu(menus).find((item) => item.label === '退出');
    assert.ok(quit?.click, '宿主允许时应有退出项');
    quit.click();
    assert.deepEqual(quits, [], 'bridge 下不得自己退');
    assert.ok(requests.includes('POST /dsh-pet-7340/quit'), '必须把退出请求交给宿主');
  });

  test('bridge 且宿主不允许：不出现退出项', async () => {
    const { tray, menus } = harness({
      isBridge: true,
      canQuit: false,
      pets: [{ label: 'a', id: 'a' }],
    });
    await tray.start();
    assert.equal(
      lastMenu(menus).some((item) => item.label === '退出'),
      false,
    );
  });
});

describe('createTray —— 托盘开关与重建', () => {
  test('托盘开关关掉：连菜单都不建（没有托盘图标）', async () => {
    const { tray, menus } = harness({ trayEnabled: false, pets: [{ label: 'a', id: 'a' }] });
    await tray.start();
    assert.equal(tray.exists(), false, '开关关掉时不建托盘');
    assert.equal(menus.length, 0);
  });

  test('refresh 重读配置：菜单被替换，退出项仍在', async () => {
    const { tray, menus } = harness({ pets: [{ label: 'a', id: 'a' }] });
    await tray.start();
    assert.deepEqual(
      lastMenu(menus).map((item) => item.label),
      ['退出'],
    );
    await tray.refresh();
    assert.equal(menus.length, 2, 'refresh 应重新设置一次菜单');
    assert.deepEqual(
      lastMenu(menus).map((item) => item.label),
      ['退出'],
      '刷新后菜单里仍然只有退出',
    );
  });

  test('没建托盘时 refresh 什么都不做（托盘开关关掉的情况）', async () => {
    const { tray, menus } = harness({ trayEnabled: false, pets: [] });
    await tray.refresh();
    assert.equal(menus.length, 0);
  });
});
