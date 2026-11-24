# AGENTS.md — MMCL 协作规范

> 本文件只写稳定规范，不记录当前阶段、测试结果、版本号或下一步；这些信息见 [docs/STATUS.md](docs/STATUS.md)。
> 文档冲突时：本文件 > [CONTEXT.md](docs/CONTEXT.md) > [DESIGN.md](docs/DESIGN.md) > [UI-DESIGN.md](docs/UI-DESIGN.md)。README 是对外门面；README 与 CONTEXT 冲突时以 CONTEXT 为准，并当天修正 README。

## 0. 文档地图（先读）

| 想知道 | 去哪里 |
|---|---|
| 当前阶段、下一步、验证结果、阻塞、版本 | [docs/STATUS.md](docs/STATUS.md)（唯一状态源） |
| 架构、里程碑定义、许可与路线图 | [docs/DESIGN.md](docs/DESIGN.md) |
| 决策、历史、迁移记录、任务背景 | [docs/CONTEXT.md](docs/CONTEXT.md) |
| UI 交互与页面规格 | [docs/UI-DESIGN.md](docs/UI-DESIGN.md) |
| 事故复盘 | `docs/INCIDENT-*.md` |
| 对外介绍与快速开始 | [README.md](README.md) |

**禁止**在 AGENTS、README、CONTEXT、DESIGN、UI-DESIGN 里复制当前阶段、测试数、版本号或下一步；需要时只链接 STATUS.md。

## 1. 项目身份与命名

- 产品名：**MMCL**（My Minecraft Launcher）；非 Mojang / Microsoft 官方产品，ISC 许可。
- 代码命名空间：根包 `mcl`、包名 `@mcl/*`、preload API `window.mcl`、类型 `MclApi`、数据目录 `.mmcl`。
- 对外文案、窗口标题、安装包名一律 MMCL；代码标识符保持 mcl。两者不是笔误，不要“顺手统一”。
- 禁止半量更名：全量改名必须单独提案，覆盖包名、import、IPC、数据目录与 userData 迁移，并单独提交。
- 包名改名会改变 Electron 的 userData 路径（当前为 `%APPDATA%\@mcl\app`），必须同时给出迁移方案。
- 不复制 HMCL / Prism / PolyMC 源码；这些是 GPLv3，只读协议文档。

## 2. 技术栈与包边界

- TypeScript 5.6（strict，全栈同一种语言）· Node ≥ 20 · pnpm workspace · Electron 33 · electron-vite 2 + Vite 5 · React 18 · 原生 CSS · Vitest 2。
- **没有** Next.js / SSR / Tailwind / 状态管理库 / ESLint；Prettier 只有 `.prettierrc.json`，依赖未安装，由编辑器扩展提供。不要按 Next.js 的直觉写代码。

```
apps/launcher/        Electron 壳：src/main + src/preload + src/renderer（React）
packages/core/        纯 TS 库：下载 / 安装 / 启动装配 / 账户 / config / 隔离语义
packages/agent/       AI 客户端（OpenAI 兼容 chat + function calling，禁 electron/react）
packages/host/        组件宿主（能力面 / 协效应，一切皆插件底座）
packages/ext-runtime/ QuickJS 沙箱 + 扩展装载 / 审核流水线
docs/                 STATUS / CONTEXT / DESIGN / UI-DESIGN / INCIDENT
```

1. `packages/core` 禁止 import `electron` 或 `react`，必须能在纯 Node + Vitest 下运行。
2. 渲染进程没有 Node 能力，一切系统访问只能经 preload 暴露的 `window.mcl.*` 白名单 IPC。
3. 主进程保持薄壳：只做 IPC 路由、窗口生命周期、调用 core；业务逻辑写进 core。
4. 新增 IPC 必须三处同步：`main/index.ts` 注册 handler → `preload/index.ts` 暴露方法 → `renderer/src/env.d.ts` 的 `MclApi` 补类型。
5. 安全基线不许放松：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，`window.open` 一律拦截。

## 3. 安全与合规基线

- 渲染层不接触 Node / fs / child_process；所有系统能力走白名单 IPC。
- IPC 参数必须校验；外部 URL 与文件路径必须校验来源和范围。
- 不在日志、文档、提交里写真实 API key、token、账号密码；设置里的 key 只回显掩码。
- 依赖许可证只允许 MIT / Apache-2.0 / BSD / ISC；LGPL 仅限动态链接且需评审；GPL/AGPL 严禁；无 LICENSE 的仓库视为不可用。
- 发布/打包配置不得出现 `--no-sandbox` / `--noSandbox`；它只是本机排障逃生舱。

## 4. 代码、测试与依赖

- TypeScript strict；跟随周边风格：2 空格、单引号、不写行尾分号、不加多余注释。
- 标识符用英文，注释与文档用中文。
- 核心逻辑改动必须带 Vitest 用例，文件放在对应包的 `test/` 下；当前至少覆盖 `packages/core`。
- 渲染层目前没有测试框架；UI 改动至少做一次桌面冒烟。新增渲染层测试基础设施需单独提案。
- 0.x 依赖用精确版本，不用 `^` / `~`；新增依赖前查许可证与依赖树。
- 不为过检查而放松类型、使用 `as any` 或吞掉异常。

## 5. 工作流与提交

| 目的 | 命令 |
|---|---|
| 开发（HMR 窗口） | `pnpm dev` |
| 类型检查（全部包 + launcher） | `pnpm typecheck` |
| 单元测试（Vitest） | `pnpm test` |
| 构建全部 | `pnpm build` |
| 冒烟自检（建窗口→写标记→退出） | `pnpm smoke` |

- `pnpm dev` 会先构建 `@mcl/core`、`@mcl/host`、`@mcl/ext-runtime` 再启动 `apps/launcher`；单独跑某个包：`pnpm --filter @mcl/core test`。
- 一步一 commit；提交前缀用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:`，说明“做了什么 + 为什么”。
- 功能、文档、版本 bump 不混在同一提交；版本只在里程碑收尾提交里改。
- UI 改动由用户在本机桌面验收；AI 会话里启动不了 GUI 时，不要假装验收过。
- 每次提交前：`git status` 只含预期文件；能跑则跑 `pnpm typecheck` 与相关测试；状态变化则更新 STATUS.md。
- 完成定义（DoD）：代码 + 测试 + 必要文档指针 + 无临时文件 + STATUS 真实。

## 6. 版本与发布规范

- 六个 package.json 始终同版本（lockstep）；当前版本与下一版本见 [docs/STATUS.md](docs/STATUS.md)。
- 只在里程碑收尾统一 bump；功能提交不改版本。
- `@mcl/app` 的 version 是产品版本，`app.getVersion()` 读取它并显示在关于页。
- 没有可分发产物就不打 git tag；首个安装包发布时再打。
- 所有包 `private: true`，不发布到 npm。
- M4.5 打包前必须评估 `productName` / `appId` 对 userData 路径的影响；若改变路径，先写迁移方案。
- 发布/打包配置禁止 `--no-sandbox`；Electron 安全基线保持 `contextIsolation/sandbox/nodeIntegration`。

## 7. 环境限制与排障

- GUI 无法在 AI 会话/受限环境启动：Electron 的 Chromium 在受监督进程树下可能启动即崩。请看窗口时让用户在本机桌面执行 `pnpm dev` 或 `pnpm smoke`。
- `pnpm test` 可能因沙箱失败：Vitest 依赖 esbuild 子进程，受限环境报 `spawn EPERM`。这是环境限制，不是用例失败；让用户在本机终端复跑。
- `pnpm smoke` 成功后写 `apps/launcher/smoke-ok.txt`；该文件不入库，CI 只判断它是否存在。
- pnpm 的构建脚本白名单键是 `allowBuilds`，写在 `pnpm-workspace.yaml`（package.json 的 `pnpm` 字段已被忽略）。
- Chromium 沙箱启动即崩（2026-11-19 已修复）：症状为启动即退、退出码 `-2147483645`（`0x80000003`）、只有 `--no-sandbox` 能出窗。复发时按 `docs/INCIDENT-2026-11-19-electron-sandbox.md` 第 7 节 SOP 处置，别先怀疑业务代码；`pnpm dev:ns` / `pnpm smoke:ns` 仅作对照实验。
- 本机没有全局 pnpm 时，用仓库约定的 Node/pnpm 运行时；不要为此改项目配置。

## 8. 禁止事项

- 不重开技术选型讨论（Tauri / .NET / Qt / Java 已否决，理由见 CONTEXT.md §2）。
- 不复制 HMCL / Prism / PolyMC 源码（GPLv3）；不引入 GPL/AGPL 依赖。
- 不提交 `out/`、`dist/`、`node_modules/`、`*.log`、`smoke-ok.txt`。
- 不为过检查放松类型或吞异常；不写 `as any` 逃避类型。
- 不在发布/打包配置里加 `--no-sandbox` / `--noSandbox`。
- 不半量更名；不在功能提交里 bump 版本；不把临时计划稿、空文件、个人草稿提交入库。
- 不在 AGENTS、README、CONTEXT、DESIGN、UI-DESIGN 复制状态信息；统一链接 STATUS.md。
- 不写真实密钥、token、账号密码到仓库或日志。

## 9. 规范维护

- 改本文件必须单独提交，并同步更新 §0 文档地图中的路径。
- 新增规范只写稳定约束；会随里程碑变化的信息放 STATUS.md，设计细节放 DESIGN/UI-DESIGN，历史决策放 CONTEXT。
- 发现文档冲突：按本文开头的优先级处理；能当天修就当天修，不把冲突留给下一位协作者。
- 规范变更需说明约束原因与影响范围，不只写“必须这样”。
