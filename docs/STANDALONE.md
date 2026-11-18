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

## 点宠物本体：冒泡编排（可自定义队列，参考鲸鱼挂件）

点一下宠物（保留点击动画与音效）不再只是打招呼，而是像鲸鱼挂件那样依次弹气泡。队列默认是：

| 顺序 | 步骤 `kind` | 内容 | 说明 |
| --- | --- | --- | --- |
| 1 | `summary` | 余额 / 额度 / 今日已用 | 与平时自动弹的余额气泡同一份数据 |
| 2 | `detail` | 窗口明细 | 5 小时、周额度与各自重置时间；服务商给了区间用量时展开成「明细 + 用量」两页 |
| 3 | `pricing` | 峰谷价目 | 当前是高峰还是空闲（谷价），距下次切换多久，Flash / Pro 命中、未命中、输出的单价（元/百万 token） |
| — | `whisper` | 碎碎念 / 对话 | 可选步骤；只有最近有碎碎念文案时才出现，没内容自动跳过 |

- 顺序、启用都可以在「设置页 → 气泡 → 点击编排」里改：每步有 ↑ ↓ 调顺序与勾选开关；落库字段是 `bubbleClickSteps`（旧配置的 `bubbleClickPages` 两开关仍被兼容，缺队列时按它推出明细/峰谷两步）。
- 队列里同类步骤只保留第一次出现；全关时退回收起态一页，绝不会点了没反应。
- 「峰谷价目」页只在同时有 DeepSeek 账户余额与窗口额度时出现（纯额度服务商没有 DeepSeek 价目可报）。
- 与鲸鱼挂件编辑器的差异：暂不做「并列随机（多选项按权重抽一个）」，自定义内容支持文本行 + 占位符 + 颜色/字号/对齐（见下一节），不支持图片行；数据页（summary/detail/pricing）仍是固定内容。
- 最后一页再点一下就收起；10 秒不动也会自动收起。
- 首次启动 / 刷新页面时余额叶子会被首拉基线吞掉，helper 与页面都会**静默预热**一次余额状态（不弹气泡、不播动画），所以刚启动就能点出编排；如果刚启动余额还没查回来（`ok` 未就绪），那一下只播点击动画，等 1–2 秒再点。
- 价目数据与挂件同源：工作日 9:00–12:00、14:00–18:00（北京时间）是高峰，其余时段与周末、法定节假日为谷价；周末谷价自 2026-08-23 起、节假日谷价自 2026-09-19 起生效。

## 自定义气泡页（占位符 / 颜色 / 字号 / 对齐）

队列里还有一个 `custom` 步骤，对应「设置页 → 气泡 → 自定义页」卡片：

- 每行一个文本模板，支持 `{token}` 占位符：`{balance}` `{tier}` `{todaySpend}` `{rolling}` `{rollingReset}` `{weekly}` `{weeklyReset}` `{peakStatus}` `{peakCountdown}` `{flashHit}` `{flashMiss}` `{flashOut}` `{proHit}` `{proMiss}` `{proOut}` `{whisper}` `{date}` `{time}`；未知 token 原样保留，缺数据显示 `--`。
- 每行可单独设颜色（#rgb / #rrggbb）、字号（8–48 px）、对齐（左/中/右），最多 6 行，可 ↑ ↓ 调行序、加一行、删一行。
- 卡片顶部有实时预览（用样本余额数据渲染），改完点「保存气泡设置」落库到 `bubbleTemplate`；队列里加了 `custom` 步骤才会在点击时出现这一页。
- 模板为空（或没配 `custom` 步骤）时该页自动跳过，不会出现空白气泡。

## 气泡优先级：谁的泡泡先占屏

宠物同一时刻只挂一个气泡（待办面板是独立窗口，单独算），优先级从高到低：

| 优先级 | 气泡 | 说明 |
| --- | --- | --- |
| 1 | 待办面板 | 用户自己打开的面板，不参与争抢 |
| 2 | 提醒确认（`waiting`） | `ask_user_question` 等你回答时——不点流程就卡住，所以压过一切普通气泡 |
| 3 | 点击编排的余额 | 手点宠物弹出的余额编排，只活 10 秒；被自动轮询顶掉就等于「点了没反应」，因此提到任务气泡之上 |
| 4 | 终态任务（`success` / `error`） | 工具调用跑完的结果，10 秒 |
| 5 | 碎碎念 / 对话 | 一句话回应 |
| 6 | 自动轮的余额 | 定时/事件触发的余额提醒，仍让位于碎碎念 |
| 7 | 环境 | 查天气之类的环境信息 |
| 8 | 非终态任务（`thinking` / `working` / `result`） | 常驻状态气泡，让位没有损失 |

设置页「桌宠」分区里的「工作状态」开关关掉时，第 2、4、8 项都不参与。

## 设置页分四个分区，各有自己的保存

右键桌宠 →「打开 AI 设置」后，左侧是四个分区，**每个分区底部只有一个保存按钮**，不用再猜：

| 分区 | 管什么 | 按钮 |
| --- | --- | --- |
| 对话 | 桌宠的聊天框 | — |
| 桌宠 | 大小、位置、碎碎念、音色、提醒等 | 保存桌宠设置 |
| 气泡 | 字体与字号、点击编排（第 2/3 页开关） | 保存气泡设置 |
| AI 服务 | 服务商、密钥、模型、余额查询、测试连接 | 保存 AI 设置 |

以前这些都挤在同一个「配置」页里、底部只有一条「保存」，很容易点错；现在按分区拆开了。气泡相关（字体/字号/编排）原来藏在「桌宠」页里，现在单独成区。

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

## 设置页连不上（Failed to fetch）

桌面版每次启动都会监听一个本机端口，设置页地址里带着这个端口。**重启桌宠后，之前打开的设置页会指向旧端口**，此时点「保存」「拉取模型」都会报浏览器级的 `Failed to fetch`。

- 处理：右键桌宠 →「打开 AI 设置」重新打开页面，再粘贴密钥、拉取模型。
- 现在启动时会优先复用上次的端口（记录在 `~/.dsh/dsh-pet/app-port.json`），只要端口没被别的程序占走，重启后旧页面也能继续用。
- 页面侧也已把这类网络错误提示成「连不上本机服务了：请从桌宠托盘菜单重新打开『打开 AI 设置』」。
