# 独立版桌宠（exe）使用说明

把 dsh-pet 打包成一个独立 Electron 应用：不装 DSH 也能当桌宠用；DSH 开着时自动接入会话工作状态、通知与余额。

## 安装位置

| 用途 | 路径 |
| --- | --- |
| 可执行文件 | `E:\projects\dsh-pet\app\dsh-pet.exe`（junction，指向 `dsh-pet\dist-app\win-unpacked`） |
| 桌面快捷方式 | 桌面「DSH 桌宠」 |
| 开机自启 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH-Pet.lnk` |
| 用户数据（配置/账本/日志） | `C:\Users\Lenovo\.dsh\dsh-pet\`（与 DSH 插件共用） |
| Electron userData | `C:\Users\Lenovo\AppData\Roaming\dsh-pet\` |

## 两种形态

1. **DSH 没开**：独立桌宠照常运行，可以显示本地账本、余额（需在右键「打开 AI 设置」里配服务商）、提醒、番茄钟等。
2. **DSH 开着**：DSH 里的 dsh-pet 插件启动后把本机入口写进
   `~/.dsh/dsh-pet/standalone-bridge.json`；独立桌宠每秒读一次并连上，于是：
   - 会话工作状态（thinking / working / waiting / result）、通知、语音、说话都来自 DSH；
   - 余额与额度以 DSH 侧为准（MiniMax 5h/周额度 + DeepSeek 账户余额 + 今日已用）；
   - DSH 侧检测到独立桌宠在跑（心跳文件 `standalone-running.json`），**不再拉起第二套桌面窗口**，只在页面里保留 overlay。

   连接日志：`[dsh-pet] DSH 桥已连接：http://127.0.0.1:<port>（…）`；断开日志：`[dsh-pet] DSH 桥已断开（…）：独立功能照常运行`，此时工作状态回落到空闲，余额沿用最后一次缓存。

## 启用 DSH 侧插件要重启一次 DSH

插件包目录被本地构建产物替换过，plugin_manager 判定为 `package-moved`，热加载不可用：

1. 菜单里退出 DSH NEXT，重新打开；
2. 确认 `~/.dsh/dsh-pet/standalone-bridge.json` 出现；
3. 独立桌宠日志里出现「DSH 桥已连接」。

## 已知限制

- 断链后余额会保留最后一次镜像值，直到本地轮询覆盖（约 30 分钟）；
- 独立模式下没有 DSH 账号态，DeepSeek 余额需要在「打开 AI 设置」里配（当前默认 provider=custom → `unsupported`）；
- 打包产物未签名，SmartScreen 可能提示；开机首次启动约需 10–20 秒才出现宠物。

## 开发循环

```bash
cd E:/projects/dsh-pet/dsh-pet
npm run build                 # tsdown + desktop-core + types
export PATH=/e/projects/dsh-pet/.tools:$PATH   # electron-builder 需要 pnpm 命令
node scripts/dist.mjs         # 产出 dist-app/win-unpacked
```

改完重新打包后，退出托盘里的桌宠再双击快捷方式即可（junction 路径不变）。
只想快速验证逻辑、不打包时，可以直接跑独立模式：

```bash
node lib/standalone.js        # 监听 3080，数据与 exe 版共用
```

从 DSH/自动化环境里启动 exe 时要先清掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 会退化成 node 进程。

## 排障

- 日志：`~/.dsh/dsh-pet/logs.txt`
- 本地接口：exe 版端口随机（日志「本机服务 http://127.0.0.1:<port>」）；独立模式固定 `http://127.0.0.1:3080/dsh-pet-7340/state`
- 心跳：`standalone-running.json` 每 30 秒刷新；PID 不存在或超过 90 秒未刷新即视为未运行
