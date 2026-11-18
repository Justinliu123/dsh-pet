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
   `~/.dsh/dsh-pet/standalone-bridge.json`；独立桌宠每秒读一次并连上。描述文件没有时（例如 DSH 侧还是旧插件、或
   插件刚重启还没写文件），独立桌宠会去读 DSH 自己的日志（`~/.dsh/logs/desktop-next*.log` 尾部的
   `dsh web: http://127.0.0.1:<port>/?token=…`）兜底发现入口，所以**多数情况下不用重启 DSH 也能连上**。连上后：
   - 会话工作状态（thinking / working / waiting / result）、通知、语音、说话都来自 DSH；
   - 余额与额度以 DSH 侧为准（MiniMax 5h/周额度 + DeepSeek 账户余额 + 今日已用）；
   - DSH 侧检测到独立桌宠在跑（心跳文件 `standalone-running.json`），**不再拉起第二套桌面窗口**，只在页面里保留 overlay。

   连接日志：`[dsh-pet] DSH 桥已连接：http://127.0.0.1:<port>（…）`；断开日志：`[dsh-pet] DSH 桥已断开（…）：独立功能照常运行`，此时工作状态回落到空闲，余额沿用最后一次缓存。

## AI 服务商：填一个 API key 就能用

右键桌宠 →「打开 AI 设置」，服务商下拉里是预制好的五家，选中后只要填 key（模型会自动预填默认值）：

| 服务商 | 默认模型 | 备注 |
| --- | --- | --- |
| DeepSeek 官方 | `deepseek-chat` | 余额按账户余额差算今日已用 |
| MiniMax（国内） | `MiniMax-M2.7` | `api.minimaxi.com`，5h/周额度 + 余额 |
| MiniMax（国际） | `MiniMax-M2.7` | `api.minimax.io` |
| opencode Go | 需自行选择 | `apiKey` 之外还带会话头 |
| commandcode | 需自行选择 | — |

- 端点不提供 `/models` 时（例如部分代理），下拉会自动退回内置候选清单并提示「已改用内置候选」；
- 真鉴权失败时报错会带上请求地址**和服务商原话**，例如「身份验证失败 (HTTP 401)：https://api.deepseek.com/models 拒绝了这把密钥（服务商原话：Authentication Fails, Your api key: ****-tail is invalid）」——打码的尾号能帮你认出「这把是不是我的 key」；
- DeepSeek 预设在地址是 `api.deepseek.com` 且密钥不以 `sk-` 开头时会直接拦下并提示：账号登录 token、别家密钥、复制被截断都会走到这里；
- 粘贴时带的 `Bearer ` 前缀和首尾引号会自动剥掉，不会因为空白被拒；
- 密钥里混入零宽字符/换行会被拒绝并提示重新复制（这种字符肉眼看不见，是 401 的常见原因）。

## 启用 DSH 侧插件要重启一次 DSH

插件包目录被本地构建产物替换过，plugin_manager 判定为 `package-moved`，热加载不可用：

1. 菜单里退出 DSH NEXT，重新打开；
2. 确认 `~/.dsh/dsh-pet/standalone-bridge.json` 出现；
3. 独立桌宠日志里出现「DSH 桥已连接」。

## 已知限制

- 断链后余额会保留最后一次镜像值，直到本地轮询覆盖（约 30 分钟）；
- 独立模式下没有 DSH 账号态，DeepSeek 余额需要在「打开 AI 设置」里配（当前默认 provider=custom → `unsupported`）；
- 打包产物未签名，SmartScreen 可能提示；但**启动已经很快**：18:19 实测从双击到桥连上约 1.5 秒（旧的 20 秒卡顿来自 DPI 探测子进程死锁，已修）；
- DPI 补偿只在探测成功后启用；探测失败按不补偿继续（主屏 scaleFactor=1 时观感无差异）。

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
- 若日志里出现 `dpi probe failed: … ETIMEDOUT`（20 秒卡顿），说明 DPI 探测子进程没起来：清掉环境里的
  `ELECTRON_RUN_AS_NODE`，并确认 `lib/app.js` 里有 `--dsh-pet-dpi-probe` 分支（ESM 主进程里不能用顶层
  `await app.whenReady()`，会死锁）
