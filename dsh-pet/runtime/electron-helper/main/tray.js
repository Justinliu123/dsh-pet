'use strict';
/**
 * 系统托盘：桌面模式的「退出」入口。
 *
 * 桌宠只显示在桌面端，托盘不再承担「把宠物送到别处」——菜单里只有退出，
 * 让没有宠物窗口时也能关掉桌宠。
 * @module dsh-pet/runtime/electron-helper/main/tray
 */

const path = require('node:path');

/**
 * 造托盘能力。
 *
 * @param deps.app - Electron app（退出）。
 * @param deps.Tray - Electron Tray 构造器。
 * @param deps.Menu - Electron Menu（模板 → 菜单）。
 * @param deps.nativeImage - Electron nativeImage（图标）。
 * @param deps.hostRequest - 与宿主通信（读配置、请求退出）。
 * @param deps.callbackUrl - bridge 回调地址（建托盘前要等它就绪）。
 * @param deps.isBridge - 是否由宿主以 bridge 模式拉起。
 * @param deps.appMode - 是否同进程应用模式。
 * @param deps.petRoute - 宠物路由前缀。
 * @param deps.platform - 托盘平台差异（tray-platform.js 的判定结果）。
 * @param deps.helperDir - runtime/electron-helper 的绝对目录（图标在包的 assets/ 下）。
 */
function createTray({
  app,
  Tray,
  Menu,
  nativeImage,
  hostRequest,
  callbackUrl,
  isBridge,
  appMode,
  petRoute,
  platform,
  helperDir,
}) {
  let tray = null;

  /** 托盘图标：包内 logo 缩到 16×16（macOS 要模板图，否则深色菜单栏下看不见） */
  function trayIcon() {
    const file = path.join(helperDir, '..', '..', 'assets', 'logo.png');
    let img = nativeImage.createFromPath(file);
    if (img.isEmpty()) {
      // 读不到图标 = 托盘不可见但菜单逻辑照跑，最难查的一种坏法：必须留下能定位的日志
      console.error('[dsh-pet-desktop-helper] tray icon missing or unreadable: ' + file);
      return img;
    }
    img = img.resize({ width: 16, height: 16 });
    if (platform.templateImage) img.setTemplateImage(true);
    return img;
  }

  /**
   * 托盘「退出」是否该出现。
   *
   * 独立应用与手动 start-desktop 流可以自己 app.quit()；isBridge 下本进程由宿主拉起，
   * 自己退会被当成崩溃按退避重启，必须先问宿主（GET /quit 的 canQuit）。
   * @returns 可以自己退出时为 true；探测失败按不支持处理，菜单项因此不出现。
   */
  async function canQuitSelf() {
    if (appMode || !isBridge) return true;
    try {
      return JSON.parse((await hostRequest('GET', petRoute + '/quit')).body || '{}').canQuit === true;
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] quit capability probe failed:', String(e && e.message ? e.message : e));
      return false;
    }
  }

  /**
   * 按当前配置拼托盘菜单；返回 null 表示此时不该有托盘（开关关掉）。
   *
   * 独立成函数是为了应用模式的重建：那边改配置只重建窗口、不重启进程，
   * 菜单得靠这里重读一次配置刷新。
   */
  async function buildMenu() {
    const resp = await hostRequest('GET', petRoute + '/config');
    const merged = JSON.parse(resp.body || '{}');
    // 托盘开关（main 条目的 trayEnabled）：只有显式 false 才不建，缺失或写坏时保持建，
    // 免得一份老配置或一个错值让托盘无声消失。
    if (merged && merged.main && merged.main.trayEnabled === false) return null;
    const canQuit = await canQuitSelf();
    const quitApp = () => {
      if (!isBridge || appMode) {
        app.quit();
        return;
      }
      // 交给宿主停机：它会先停本进程再退，所以这条请求不用等结果
      hostRequest('POST', petRoute + '/quit').catch((e) => {
        console.error('[dsh-pet-desktop-helper] tray quit failed:', String(e && e.message ? e.message : e));
      });
    };
    return Menu.buildFromTemplate(canQuit ? [{ label: '退出', click: quitApp }] : []);
  }

  /**
   * 建托盘：菜单里只有「退出」——没有宠物窗口时也能关掉桌宠。
   */
  async function startTray() {
    try {
      // 请求行要携带回调 URL，而端口在 startBridgeCallback 的 listen 回调里才有值（最多等 2s）
      for (let i = 0; isBridge && !callbackUrl() && i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const menu = await buildMenu();
      if (menu === null) return;
      tray = new Tray(trayIcon());
      tray.setToolTip('dsh-pet 桌面宠物');
      tray.setContextMenu(menu);
      // Windows 上 setContextMenu 只接管右键，左键默认什么都不做（macOS 相反：左键即弹菜单）
      if (platform.leftClickPopsMenu) tray.on('click', () => tray.popUpContextMenu());
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] tray init failed:', String(e && e.message ? e.message : e));
    }
  }

  /** 重读配置并刷新菜单；没建托盘时什么都不做（应用模式重建窗口后调用）。 */
  async function refreshTray() {
    if (!tray) return;
    try {
      const menu = await buildMenu();
      if (menu !== null) tray.setContextMenu(menu);
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] tray refresh failed:', String(e && e.message ? e.message : e));
    }
  }

  return {
    start: startTray,
    refresh: refreshTray,
    exists: () => tray !== null,
    destroy() {
      if (!tray) return;
      try {
        tray.destroy();
      } catch (e) {
        console.error('[dsh-pet-desktop-helper] tray destroy failed:', String(e && e.message ? e.message : e));
      }
      tray = null;
    },
  };
}

module.exports = { createTray };
