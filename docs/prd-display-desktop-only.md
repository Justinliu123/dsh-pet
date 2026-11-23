# PRD：显示位置收敛为「仅桌面」

> **状态：已实现**（口径已确认，代码已落地并通过门禁与打包实测）
> 日期：2026-11-23
> 触发：用户要求「显示位置只保留仅桌面，其他显示位置的设置全部去掉，关于显示位置的处理逻辑代码等都去掉」
> 阻塞项：无

## 1. 背景

桌宠现在有两套「显示位置」机制咬合在一起：

1. **配置字段 `display`**（`none` / `web` / `desktop` / `both`）——决定这只宠物显示在哪一端。
2. **HTTP 参数 `?surface=`**（`web` / `desktop` / `both` / `any`）——调用方声明自己在哪一端操作。

两者靠 `src/host/surface.ts` 的 `displayCovers()` 汇合：`?surface=` 先按「调用方要哪一端」校验，再拿宠物的 `display` 对齐，对不上回 `pet-not-displayed`。

这套机制成立的前提是「同一只宠物能同时活在网页端与桌面端」。但插件自 `e865c96`（「插件降级为纯数据通道」）起已移除 `dsh.client` 声明，DSH 网页端不再加载 dsh-pet 的浏览器半侧，网页端既无宠物也无它的 toast——**网页端这条路实际已经断了**，留下的是一整套没人走的分支、设置入口与对外契约。

本次要把这条概念整体收掉：宠物一律显示在桌面端，其余显示位置的设置与处理逻辑全部删除，不留兼容层。

## 2. 目标与非目标

### 目标

1. 宠物一律显示在桌面端；配置里不再有 `display` 字段。
2. 删掉除「仅桌面」外的所有显示位置设置入口：设置页下拉、托盘勾选项、桌面右键「显示位置」子菜单、数字键 1–4 轮转。
3. 删掉所有按显示位置分支的处理逻辑（宿主半侧 + 独立版 + runtime + 网页半侧）。
4. 删掉对外的 `?surface=` 请求参数、配套校验与 `pet-not-displayed` 错误码。
5. 网页半侧 `src/client/**` 里的显示位置代码一起清干净，不留死代码。

### 非目标

- 不删 `src/client/**` 整体——本次只清显示位置相关的部分。
- 不动 `src/shared/voice.ts` 的「渲染端身份」（`surface === 'web' | 'desktop'`）与 `src/shared/state.ts` 的 `VoiceTarget` 联合类型：那是「这一端是不是我」，与「宠物显示在哪」是两回事。
- 不动 X11 的 `DISPLAY` / `WAYLAND_DISPLAY` 环境变量、Electron 屏幕 API、多显示器几何。
- 不动「显示名」（`petDisplayName`）与第三方 API 的 `display_name`。
- 不改多开、占用锁、睡觉、余额等其它机制。

## 3. 决策记录（2026-11-23 用户确认）

| 决策点 | 取值 |
| --- | --- |
| `display` 配置字段 | **彻底删除**：不留字段、不留常量、不留兼容层 |
| `?surface=` HTTP 参数 | **连同全部校验与错误码一起删除** |
| 网页半侧 `src/client/**` | **一起清掉** |
| 老配置里的 `display` 键 | 读取时忽略、保存时丢弃，**不告警**（不打扰升级的用户） |
| 旧调用方传的 `?surface=web` | 忽略该参数，**不再 400**，操作直接落到桌面那只 |
| `POST /pet-display` 端点 | 删除（调用不再受理；落到素材兜底分支回 `400`，与其它未知路径同口径） |
| 语音播给哪一端 | 恒为 `desktop` |
| 宠物可见性 | 恒为「可见」：碎碎念、待办播报、余额播报不再按显示位置跳过 |

## 4. 现状清点（调研结论）

### 4.1 两套机制的关键节点

| 机制 | 关键文件 | 职责 |
| --- | --- | --- |
| 配置字段 `display` | `src/shared/types.ts`（`PetDisplay` 类型 + `Pet.display`）、`src/shared/config.ts`（`PET_DISPLAYS` 白名单 + `isWebVisible` + `isDesktopVisible`）、`src/host/config/constants.ts`（`PET_DISPLAY_SET`） | 声明取值、判可见性 |
| 读配置 | `src/host/config/merge.ts`（合并）、`src/host/config/save.ts`（校验 + 写回） | 进出配置 |
| 写配置 | `src/host/routes/config/display.ts`（`POST /pet-display`） | 改单只宠物的显示位置 |
| HTTP 参数 `?surface=` | `src/host/surface.ts`（类型/校验/语音面推导）、`src/host/plugin/pet-lookup.ts`（参数校验 + 与 display 对齐） | 调用方声明自己在哪一端 |
| 路由层 | `src/host/routes/{interaction,motion,chat,balance,environment}.ts` | 8 个端点把 surface 列为必填 |

### 4.2 按显示位置分支的读取点（重构时要全部删掉）

`src/host/surface.ts`（`displayCovers` / `isDisplayed` / `pickVoiceSurface`）、
`src/host/plugin/pet-lookup.ts`、`src/host/plugin/loops.ts`（碎碎念跳过不显示的宠物，#237）、
`src/host/plugin/todo-reminders.ts`（跳过 + 选播报端）、`src/host/plugin/command-balance.ts`、
`src/host/plugin/chat-memory.ts`（`voiceTo` 推导）、`src/host/plugin/desktop/pets.ts`、
`src/host/routes/motion.ts`（`GET /pose` 门禁）、`src/host/system-notify/loop.ts`（转述挑人）、
`src/client/pet/multi.ts`（网页 overlay 过滤）、`src/app/main.ts`、`src/standalone/options.ts`。

### 4.3 三个容易漏的面

1. **`runtime/electron-helper/**` 是独立于 `src/` 的第二套实现**：托盘勾选与四值轮转（`main/tray.js`）、桌面右键「显示位置」子菜单（`sprite/menu.js`）、数字键 1–4 切显示位置（`sprite/input.js`）、renderer 的可见性过滤（`renderer.js`）。不动它，桌面端仍会写 `display`。
   其中 `shared-core.js` 是 `npm run build:desktop-core` 的**生成物**（源在 `src/shared/index.ts`），改 shared 后重跑即可。
2. **`isDesktopVisible` 有四份重复实现**：`src/shared/config.ts`、`src/host/plugin/desktop/pets.ts`、`src/app/main.ts`、`src/standalone/options.ts`（外加 runtime 的 `renderer.js` 走 shared 那份）。改一处不会自动同步其余。
3. **对外契约面**：`openapi.yaml` 里 `SurfaceQuery` 是 `$ref` 给 8 个端点用的，`/balance` 与 `/environment` 另有两份**内联**版本（文案还不一样）；`PetEntry.display`、`POST /pet-display`、错误实体里的 `display` 回带都要一起处理。

### 4.4 假阳性（重构时不要动）

- CSS `display` 属性与 React `style.display`（`settings-page/style.ts`、`client/settings/css.ts`、`client/chat/panel-css.ts`、`shared/menu/mount.ts`、`shared/chat/dom.ts` 等）。
- X11 `DISPLAY` / `WAYLAND_DISPLAY` 环境变量与 Electron 屏幕 API（`host/plugin/desktop/spawn.ts`、`runtime/electron-helper/main/displays.js`）。
- `shared/balance/parse.ts` 里 CSS-in-JS 内联样式键白名单中的 `'display'`。
- 「显示名」相关（`host/index.ts` 的 `petDisplayName`、`ai-provider/list-models.ts` 的 `display_name`）。

## 5. 改动清单

### 5.1 类型与常量

| 文件 | 改动 |
| --- | --- |
| `src/shared/types.ts` | 删 `PetDisplay` 类型、`Pet.display` 字段；改写 `whisperEnabled` 与「切回桌面」两处相关注释 |
| `src/shared/config.ts` | 删 `PET_DISPLAYS`、`isWebVisible`、`isDesktopVisible` |
| `src/shared/index.ts` | 删 `export * from './display-hotkey.ts'`（`config.ts` 是整目录 re-export，里面的函数删掉即随之消失） |
| `src/host/config/constants.ts` | 删 `PET_DISPLAY_SET` |
| **新增** `src/host/voice-target.ts` | 宿主侧唯一的语音面：`VoiceTarget` 类型（收窄为 `'desktop'`）+ `VOICE_TARGET_DESKTOP` 常量。替代原 `src/host/surface.ts` 里的同名定义，避免 `'desktop'` 字面量散落 |

### 5.2 宿主半侧

| 文件 | 改动 |
| --- | --- |
| `src/host/surface.ts` | **整文件删除**（`Surface` / `SURFACES` / `SURFACE_TEXT` / `normalizeSurface` / `displayCovers` / `isDisplayed` / `pickVoiceSurface` / `voiceTargetOfSurface`） |
| `src/host/surface.test.ts` | **整文件删除** |
| `src/host/plugin/pet-lookup.ts` | 删 `surfaceParam` / `surfaceMismatch` / `surfaceBlocked`；`requirePet` 的 `opts.surface` 分支与 `opts` 参数整体删（它只有 surface 一个用途） |
| `src/host/routes/interaction.ts` | 删 `/lock`、`/whisper`、`/broadcast`、`/bubble/clear` 的 surface 校验；whisper/broadcast 的 `voiceTo` 恒为桌面 |
| `src/host/routes/motion.ts` | 删 `/anim`、`/position`、`/throw` 的 surface 校验；`GET /pose` 的 display 门禁删（桌面端恒可见） |
| `src/host/routes/chat.ts` | 删 `POST /chat` 的 surface 校验分支 |
| `src/host/routes/balance.ts`、`src/host/routes/environment.ts` | 删 surface 校验 |
| `src/host/routes/types.ts` | 删 `surfaceBlocked` 声明与 `requirePet` 的 `opts` |
| `src/host/plugin/loops.ts` | 删「配置上不显示就整体跳过」的分支（#237） |
| `src/host/plugin/todo-reminders.ts` | 删 `display === 'none'` 跳过、网页端优先、`pickVoiceSurface` |
| `src/host/plugin/command-balance.ts` | 删 `display !== 'none'` 过滤 |
| `src/host/plugin/chat-memory.ts` | `voiceTargetFor` 恒为桌面 |
| `src/host/plugin/desktop/pets.ts` | 删本文件自带的 `isDesktopVisible` 副本；桌面宠物 = 全部实例 |
| `src/host/routes/config/display.ts` | **整文件删除**（`POST /pet-display`） |
| `src/host/routes/config/index.ts` | 删 `pet-display` 分发与 import |
| `src/host/routes/config/entry.ts` | 删 `display` 字段白名单与「改成 none 就撤销占用锁」 |
| `src/host/config/merge.ts` | 删 `display` 合并行（不再产出该字段） |
| `src/host/config/save.ts` | 删 `display` 校验与写回（写回是白名单重建，多余键自动丢弃） |
| `src/host/config/read.ts` | 改「`POST /pet-display` 写文件宠物 display」那段注释 |
| `src/host/state.ts` | 改 `config` 段注释（唯一写方不再是 `/pet-display`） |
| `src/host/plugin/http-route.ts` | 配置写队列里去掉 `pet-display` 分支 |
| `src/host/system-notify/loop.ts` | `pickSpeaker` 去掉 `displayCovers` 判断（恒有桌面宠物可挑） |

### 5.3 runtime（桌面 Helper，第二套实现）

| 文件 | 改动 |
| --- | --- |
| `runtime/electron-helper/main/tray.js` | 删托盘里的「显示位置」勾选项、`toggleDisplay` 四值轮转、`traySetPetDisplay` |
| `runtime/electron-helper/sprite/menu.js` | 删桌面右键「显示位置」子菜单与 `setPetDisplay` 写回 |
| `runtime/electron-helper/sprite/input.js` | 删数字键 1–4 切显示位置 |
| `runtime/electron-helper/renderer.js` | `isDesktopVisible` 过滤删（全部实例都建窗） |
| `runtime/electron-helper/shared-core.js` | **生成物**：改完 `src/shared/**` 后跑 `npm run build:desktop-core` 重生成，不手改 |

### 5.4 网页半侧与共享层

| 文件 | 改动 |
| --- | --- |
| `src/shared/display-hotkey.ts` + `display-hotkey.test.ts` | **整文件删除** |
| `src/shared/menu/tree.ts` | 删 `DISPLAY_LABELS`、`displayMenuBranch`、`SLEEP_ALLOWED_ACTIONS` 里的 `set-display` |
| `src/shared/menu/types.ts` | 删 `MenuLeaf.display` |
| `src/shared/chat/dialog.ts` | 拼 URL 时不再带 `surface`（弹窗端身份字段保留） |
| `src/client/pet/multi.ts` | 删 `isWebVisible` 过滤 |
| `src/client/pet/menu-actions.ts` | 删 `switchDisplay` 与「显示位置」菜单动作；请求 URL 里的 `surface` 参数删 |
| `src/client/pet/card/entry.ts` | 删数字键切显示位置、`displayMenuBranch` 注入、`switchDisplayRef` |
| `src/client/settings/pet-card-parts.ts` | 删「显示位置」下拉 |
| `src/client/settings/pet-draft.ts` | 删草稿复制 `display` |
| `src/client/settings/config/pack-writes.ts` | 写回指纹里的 `display` 删 |
| `src/client/settings/shortcuts-card.ts` | 删显示位置快捷键提示 |
| `src/client/settings/locales/{zh,en,de,es,fr,ja,pt,ru}.ts` | 删 `displayLabel` / `displayHint` / `display.*` 文案（8 个语种键集须保持一致） |
| `src/client/baifan/{lock,show}.ts`、`src/client/chat/api.ts` | 请求 URL 里的 `surface` 参数删 |

### 5.5 独立版与 app

| 文件 | 改动 |
| --- | --- |
| `src/standalone/settings-page/script/pet-card.ts` | 删「显示位置」下拉与表单里的 `display` 初值 |
| `src/standalone/settings-page/script/widgets.ts` | 删 `displayLabel` |
| `src/standalone/settings-page.ts` | 删 `PET_DISPLAYS` 注入 |
| `src/standalone/settings-page/script/core.ts` | 删 `DISPLAYS` 页面常量 |
| `src/standalone/options.ts` | 删 `describePets` 里的 `display=` 打印与本文件的 `isDesktopVisible` 副本 |
| `src/standalone/cli.ts` | 「桌面小窗 0 只：display 需要 desktop 或 both」提示改写 |
| `src/standalone/check.ts` | 自检只统计桌面宠物的口径改为「全部实例」 |
| `src/app/main.ts` | 桌面可见清单改为全部实例；状态接口与落地页的 `display` 透传删 |

### 5.6 配置与对外契约

| 文件 | 改动 |
| --- | --- |
| `assets/config.jsonc` | 删 `display` 默认值与相关注释（含「缺失按默认 both 处理」的迁移说明） |
| `openapi.yaml` | 删 `SurfaceQuery` 参数定义、8 处 `$ref`、2 处内联（`/balance`、`/environment`）、`pet-not-displayed` 的 `display` 回带、错误实体里的 `display` 字段、`PetEntry.display` 与配置写入体的 `display`、`POST /pet-display` 端点、失败码枚举里的相关项 |
| `API.md` | 同步端点参数与失败码 |
| `CONFIG.md` | 删「显示位置」字段说明与示例 |
| `INSTALL.md` | 删「只显示 display 含 desktop/both 的实例」与默认 `display: "both"` 的说明 |
| `README.md` / `FEATURES.md` | 删显示位置相关条目与「按显示位置推导哪一端出声」的描述 |

### 5.7 测试

**整文件删除**：`src/host/surface.test.ts`、`src/shared/display-hotkey.test.ts`。

**改写**（去掉 display/surface 维度，保留其余行为断言）：
`src/host/routes.test.ts`、`src/host/routes/interaction.test.ts`、`src/host/routes/balance.test.ts`、`src/host/routes/environment.test.ts`、`src/host/routes/chat-delete.test.ts`、`src/host/routes/config/entry.test.ts`、`src/host/desktop-pets.test.ts`、`src/host/desktop-tray.test.ts`、`src/host/desktop-reload.test.ts`、`src/host/config-concurrency.test.ts`、`src/host/config.test.ts`、`src/host/chat-memory.test.ts`、`src/host/plugin/loops.test.ts`、`src/host/plugin/todo-reminders.test.ts`、`src/host/system-notify/loop.test.ts`、`src/shared/config.test.ts`、`src/client/settings/pet-card.test.ts`、`src/client/pet/menu-actions.test.ts`、`src/client/chat/api.test.ts`、`src/standalone/options.test.ts`。

**夹具清理**：各测试夹具里的 `display:` 行删（`standalone/integration.test.ts`、`client/settings/use-pet-list.test.ts`、`client/settings/config/pack-writes.test.ts`、`host/memory/powercontext.test.ts`、`host/config-concurrency.test.ts` 等）。

**注意**：`src/shared/config.test.ts:136` 断言「返回成品聚合的写端点恰好 5 处」（含 `/pet-display`）→ 删端点后改为 4。
`src/host/desktop-reload.test.ts:77` 是读 `routes/config/display.ts` **源码文本**的守卫 → 该文件消失，守卫一并删（按仓库规范 §16.4，读源码的守卫只减不增）。

## 6. 迁移与兼容口径

| 场景 | 口径 |
| --- | --- |
| 老配置里有 `"display": "none" / "web" / "both"` | 读取时忽略该键，宠物按桌面显示；**不告警、不报错**。下次保存时按白名单重建，多余键自然消失 |
| 老配置缺 `display` | 同样正常，无差异 |
| 第三方调用方传 `?surface=web` | 参数被忽略，操作落到桌面那只；**不再回 `bad-request` / `pet-not-displayed`** |
| 第三方调用方调 `POST /pet-display` | 端点已删 → 不再受理，落到素材兜底分支回 `400`（未知路径的通用口径，非本端点特有） |
| 宠物从「托盘模式」变成「桌面常驻」 | 原本 `display: none` 的用户，升级后宠物会出现在桌面上。这是本次收敛的直接后果（用户已确认「只保留仅桌面」） |
| 占用锁 | 原先「改成 none 就撤销占用锁」的口径随 `/pet-display` 一起消失；锁仍按 TTL 与释放端点正常运作 |

## 7. 风险

1. **漏掉 runtime**：第二套实现（托盘/右键/数字键）不在 `src/` 下，grep `src/` 找不到——已列入 §5.3，但实现时仍要逐个文件核对。
2. **`isDesktopVisible` 四份副本**：删掉 shared 那份后，其余三份必须同步删，否则编译期就会暴露（反而是好事）。
3. **`openapi.yaml` 的两份内联 surface**：`/balance` 与 `/environment` 不是 `$ref`，删的时候容易漏。
4. **对外契约是破坏性变更**：第三方若依赖 `pet-not-displayed` 判断「宠物是不是没显示在某一端」，该判据消失，改为恒成立。
5. **locale 键集一致性**：8 个语种必须同步删键，`check:openapi` 之外还需确认没有 locale 键集守卫变红。
6. **用户当前配置**：`main-config.jsonc` 里是 `"display": "none"`，改动生效后宠物会上桌面；如不希望如此，改回前需先在设置页把显示方式调整好——但本次已确认统一为「仅桌面」，故按新口径执行。

## 8. 验证计划

1. **门禁**（在 `dsh-pet/` 下依次跑）：`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run check:cycles`、`npm run check:runtime`、`npm run check:openapi`、`npm test`、`npm run build`。
   - 基线说明：本次改动前 `tsc -p tsconfig.test.json` 已有 6 个测试文件的既有报错（`bubble-slots` / `click-steps` / `balance-template` / `context-ai` / `dsh-bridge` / `settings`），相关文件自 `a9f806f` 起未动，本次不得新增同类报错。
2. **针对性回归**：逐个跑被改写的测试文件，确认删掉的只是 display/surface 维度，其余行为断言仍在。
3. **端到端**（独立版 exe）：
   - 重新打包到 `D:\deepseek\dsh-pet-app`（注意：electron-builder 需要 `pnpm` 在 PATH，本机用 corepack 垫片）。
   - 启动后确认宠物出现在桌面、日志无 `pet-not-displayed`。
   - 用 `POST /whisper?pet=main`（不带 surface）验证气泡与语音仍出得来。
4. **视觉检查**：独立版设置页不再有「显示位置」下拉；桌面端右键菜单与托盘菜单不再有「显示位置」项；数字键 1–4 不再切换显示位置。

## 9. 实施顺序

1. **共享层**：删 `PetDisplay` / `PET_DISPLAYS` / `isWebVisible` / `isDesktopVisible`，新增 `src/host/voice-target.ts`，删 `display-hotkey.ts`，改 `shared/menu/tree.ts`、`shared/menu/types.ts`、`shared/chat/dialog.ts`。
2. **宿主半侧**：删 `src/host/surface.ts` 与测试 → 改 `pet-lookup.ts` → 改各路由 → 改各插件（loops / todo-reminders / command-balance / chat-memory / desktop-pets）→ 删 `routes/config/display.ts` → 改 `config/{merge,save,read,constants}.ts` → 改 `state.ts`、`http-route.ts`、`system-notify/loop.ts`。
3. **runtime**：改 `main/tray.js`、`sprite/menu.js`、`sprite/input.js`、`renderer.js` → 跑 `npm run build:desktop-core` 重生成 `shared-core.js`。
4. **网页半侧**：改 `client/pet/{multi,menu-actions,card/entry}.ts`、`client/settings/**`、`client/baifan/**`、`client/chat/api.ts`、8 个 locale。
5. **独立版与 app**：改 `standalone/**`、`app/main.ts`。
6. **配置与契约**：`assets/config.jsonc`、`openapi.yaml`、5 份文档。
7. **测试**：删 2 个测试文件 → 改 20 个测试文件与夹具。
8. **门禁全跑** → 端到端实测 → 提交（提交信息走 `git-commit` 规范）。

每一步结束跑一次相关单测，最后跑全套门禁。
