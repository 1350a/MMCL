# AGENTS.md — MCL 协作契约

> 给 AI 协作者（DSH / Claude Code / Cursor 等）和未来的自己看的**工作契约**。
> 背景与理由在 [docs/CONTEXT.md](docs/CONTEXT.md)（技术栈 / 决策 / 任务清单）和 [docs/DESIGN.md](docs/DESIGN.md)（架构 / 许可 / 路线图）。
> 若三份文件冲突：**本文件 > CONTEXT.md > DESIGN.md**。

## 1. 这是什么项目

AI 驱动的 Minecraft Java 版**第三方启动器**（Electron 桌面应用）。非 Mojang 官方产品，ISC 许可。

当前阶段：**M1~M6 已完成并验收**（原版启动 / Java 运行时 / AI 助手 / 外置登录 / Fabric+Modrinth / 扩展系统 / 多实例）；**UI 重构 C1~C7 已提交验收**（三大件 + 主页 / 下载页 / 设置页全部接入，260 测试绿），下一步 C8 插件页 → C9 收尾（设计见 `docs/UI-DESIGN.md`）。

## 2. 技术栈速查

TypeScript 5.6（strict，全栈同一种语言）· Node ≥ 20 · pnpm workspace · Electron 33 · electron-vite 2 + Vite 5 · React 18 · 原生 CSS · Vitest 2。

**没有** Next.js / SSR / Tailwind / 状态管理库 / ESLint；Prettier 只有 `.prettierrc.json`（依赖未安装，由编辑器扩展提供）—— 不要按 Next.js 的直觉写代码。

## 3. 常用命令（在仓库根目录执行）

| 目的 | 命令 |
|---|---|
| 开发（HMR 窗口） | `pnpm dev` |
| 类型检查（core + node + web 三套） | `pnpm typecheck` |
| 单元测试（Vitest） | `pnpm test` |
| 构建全部 | `pnpm build` |
| 冒烟自检（建窗口→写标记→退出） | `pnpm smoke` |

`pnpm dev` 会先构建 `@mcl/core` 再启动 `apps/launcher`。单独跑某个包：`pnpm --filter @mcl/core test`。

## 4. 目录与边界（硬规则）

```
apps/launcher/       Electron 壳：src/main（主进程）+ src/preload + src/renderer（React）
packages/core/       纯 TS 库：下载 / 安装 / 启动装配 / 账户 / config / 隔离语义等业务逻辑
packages/agent/      AI 客户端（OpenAI 兼容 chat + function calling，禁 electron/react）
packages/host/       组件宿主（能力面/协效应，一切皆插件底座）
packages/ext-runtime/ QuickJS 沙箱 + 扩展装载/审核流水线
docs/                CONTEXT.md（交接）/ DESIGN.md（设计）/ UI-DESIGN.md（UI 交互）
```

1. **`packages/core` 禁止 import `electron` 或 `react`** —— 它必须能在纯 Node + Vitest 下运行，未来可被 CLI 或别的壳复用。
2. **渲染进程没有 Node 能力**，一切系统访问只能经 preload 暴露的 `window.mcl.*` 白名单 IPC。
3. **主进程保持"薄壳"**：只做 IPC 路由、窗口生命周期、调用 core；业务逻辑写进 core。
4. 新增一个 IPC 要**三处同步**改：`main/index.ts` 注册 handler → `preload/index.ts` 暴露方法 → `renderer/src/env.d.ts` 的 `MclApi` 补类型。
5. **安全基线不许放松**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，`window.open` 一律拦截。

## 5. 代码约定

- TypeScript **strict**；改文件时跟随周边风格：2 空格、单引号、**不写行尾分号**、不加多余注释。
- 标识符用英文，注释与文档用中文。
- 核心逻辑改动必须带 Vitest 用例，文件放在 `packages/core/test/`。
- 新增依赖前先查许可证：只允许 MIT / Apache-2.0 / BSD；**GPL/AGPL 一律禁止**，无 LICENSE 的仓库视为不可用。

## 6. 环境限制（不是项目 bug）

- **GUI 无法在 AI 会话/受限环境启动**：Electron 的 Chromium 在受监督进程树下启动即崩。需要看窗口时，请让用户在本机桌面执行 `pnpm dev` 或 `pnpm smoke`。
- **`pnpm test` 可能因沙箱告败**：Vitest 依赖 esbuild 子进程（管道通信），受限环境下报 `spawn EPERM`。这是环境限制，不是用例失败 —— 让用户在本机终端复跑。`pnpm typecheck` 通常可用。
- `pnpm smoke` 成功后写 `apps/launcher/smoke-ok.txt`；CI 判断该文件即可。
- pnpm 的构建脚本白名单键是 `allowBuilds`，写在 `pnpm-workspace.yaml`（package.json 的 `pnpm` 字段已被忽略）。
- **Chromium 沙箱启动即崩（2026-11-19 已修复）**：曾经 `pnpm dev` / `pnpm smoke` 启动即退（退出码 `-2147483645` = `0x80000003`），只有 `--no-sandbox` 能出窗。根因是 pnpm 首次安装的 Electron `dist` 与官方发布包不一致；换成干净官方 `dist` 后已恢复，**日常不需要 `--no-sandbox`**。复发时按 `docs/INCIDENT-2026-11-19-electron-sandbox.md` 第 7 节 SOP 处置，别先怀疑业务代码。逃生舱 `pnpm dev:ns` / `pnpm smoke:ns` 仅作对照实验。

## 7. 下一步（UI 重构收尾，按顺序）

C8 插件页（`ext:*` 五通道 + 审核/管理 UI 从旧卡迁入页面）→ C9 收尾（孤儿旧卡片 VersionsCard/ModsCard/JavaCard/AccountsCard/AiCard/InstancesCard/Ext*Card 清理、CONTEXT/DESIGN 收口）。之后候选：M4.5 发布准备（electron-builder 打包；asar 需换 quickjs singlefile 变体）。详见 CONTEXT.md §1 与 `docs/UI-DESIGN.md` §8。

## 8. 不要做的事

- 不要重开技术选型讨论（Tauri / .NET / Qt / Java 已否决，理由见 CONTEXT.md §2）。
- 不要复制 HMCL / Prism / PolyMC 源码（GPLv3），只能读协议文档。
- 不要提交 `out/`、`dist/`、`node_modules/`、`*.log`、`smoke-ok.txt`。
- 不要为了过检查而放松类型或吞掉异常。
- 不要在发布/打包配置里加 `--no-sandbox` 或 `--noSandbox`；它只是本机排障的逃生舱（见 §6）。
