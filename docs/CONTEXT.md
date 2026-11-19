# MCL 项目上下文（交接文档）

> 这份文件是项目的"可迁移记忆"：技术栈、关键决策、任务清单、运行方式、迁移记录。
> 新会话、新协作者、未来的我：**先读这份，再读 [DESIGN.md](./DESIGN.md) 的 3/7/8 节**，然后跑 `pnpm test` 确认基线。

最后更新：2026-11-18（迁移至 `C:\Users\Mac\Project\mcl` 当天）

---

## 1. 项目身份

| 项 | 值 |
|---|---|
| 代号 | **MCL**（产品正式名待定，务必避开 "Minecraft" 商标） |
| 一句话 | AI 驱动的 Minecraft Java 版第三方启动器 |
| 仓库位置 | `C:\Users\Mac\Project\mcl`（2026-11-18 从 DSH 工作区迁入） |
| 许可证 | **ISC**（见 [LICENSE](../LICENSE)） |
| Git | `main` 分支，首个 commit `fa77480`（2026-11-18 初始化 M0 脚手架） |
| 当前阶段 | **M0 完成**（脚手架 + 核心库 + 单测 + 构建全绿） |
| 开发者 | 个人开发者（新手），因此选型第一优先级是"一种语言、学习曲线平缓" |

---

## 2. 技术栈（已定稿）

| 层 | 选型 | 本机实测版本 | 选它的理由 |
|---|---|---|---|
| 语言（全栈） | TypeScript 5.6 | 5.6.3 | 主进程/preload/UI/核心库一种语言 |
| 运行时 | Node.js ≥ 20 | v24.21.0 | Electron 内置同源运行时 |
| 包管理 | pnpm workspace | 11.28.5 | monorepo + 硬链接省磁盘 |
| 桌面壳 | Electron | 33.4.11 | 生态最成熟；`core` 不依赖它，保留换壳路径 |
| 构建 | electron-vite + Vite 5 | 2.4.1 / 5.4.21 | 三端（main/preload/renderer）统一配置 + HMR |
| UI | React 18 + 原生 CSS | 18.3.1 | AI 生成代码样本最多；无 UI 框架依赖 |
| 测试 | Vitest | 2.1.9 | 与 Vite 同源，零额外配置 |
| 核心库 | `@mcl/core`（纯 TS，**禁止** import electron） | — | 可被未来 Tauri 壳/CLI 复用 |
| AI 接入 | **仅 OpenAI 兼容协议**（baseURL + apiKey + model） | 未接 SDK | 一个适配器覆盖 OpenAI/DeepSeek/Kimi/GLM/Ollama |
| 扩展沙箱（M5） | QuickJS（WASM） | 未引入 | 毫秒级隔离、可限制算力，可热加载 |

### 被否决的方案（别再重新讨论）

| 方案 | 否决原因 |
|---|---|
| Tauri（Rust） | 新手学习曲线陡，AI 编码生态弱于 TS |
| Avalonia / .NET | 双语言，跨端收益不足以抵消成本 |
| Qt（C++/PySide） | LGPL 与"扩展系统"分发场景纠缠 |
| Java + Compose Desktop | 与 Minecraft 生态近但 AI 生态弱，打包臃肿 |

---

## 3. 关键决策（对话结论摘要）

按讨论顺序，这些是已经**拍板**的结论，除非有新技术事实否则不再翻案：

1. **产品定位**：Minecraft Java 第三方启动器，非官方，AI 是一等公民而非附加插件。
2. **平台**：Windows 优先，但架构不锁死（不写 Windows-only 假设进 core）。
3. **技术栈**：由我（AI）综合权衡后定 → Electron + TypeScript（ADR-001）。
4. **AI 深度**：三层全要 —— ①对话助手（崩溃日志分析）②智能体操作启动器 ③AI 生成/修改扩展。
5. **MVP 的 AI 最小化**：只做"用户自配 API key 的聊天面板 + 读日志 + 版本状态"，不预置模型、不内置权重。
6. **登录**：MVP **不做微软 OAuth**；先离线登录（离线 UUID），再实现 authlib-injector 文档化协议（**不复制**其 GPLv3 参考实现）。
7. **许可证红线**：只接受 MIT/Apache/BSD；LGPL 仅允许动态链接；**GPL 系一律不碰**；无许可证仓库视为不可用。
8. **下载**：`.part` 中间文件 + HTTP Range 断点续传 + SHA1 校验通过后才改名为正式文件。
9. **安全基线**：`contextIsolation:true` + `sandbox:true` + `nodeIntegration:false`，`window.open` 拦截，IPC 参数校验，preload 只暴露白名单 `window.mcl`。
10. **架构分层**：`apps/launcher`（Electron 壳）/ `packages/core`（纯逻辑）/ 未来 `packages/agent`、`packages/ext-runtime`。

---

## 4. 任务清单

### 4.1 M0 —— 已完成（2026-11-18）

| 交付项 | 文件 |
|---|---|
| monorepo + workspace + ISC 许可 | `package.json` / `pnpm-workspace.yaml` / `LICENSE` |
| 设计文档（定位/架构/许可证/路线图/ADR） | `docs/DESIGN.md` |
| 核心库：下载（Range 续传 + SHA1 校验后改名） | `packages/core/src/download.ts` |
| 核心库：哈希与校验 | `packages/core/src/verify.ts`、`errors.ts` |
| Electron 壳：窗口 + IPC 自检 + smoke 模式 | `apps/launcher/src/main/index.ts` |
| preload 白名单桥 | `apps/launcher/src/preload/index.ts` |
| React 自检 UI | `apps/launcher/src/renderer/**` |
| 单元测试 5 例 | `packages/core/test/download.test.ts` |

**验证矩阵（迁移后复跑，全绿）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `pnpm install` | ✅ 完成（Electron 二进制已落地） |
| 类型检查 ×3 | `pnpm -r typecheck` | ✅ core / node / web 全 0 错误 |
| 单元测试 | `pnpm test` | ✅ 5/5 通过（完整下载+SHA1、断点续传、校验失败清理、404、verifyFile） |
| 构建 | `pnpm build` | ✅ main 2.05 kB、preload 0.25 kB、renderer 216.78 kB |
| GUI 冒烟 | `pnpm dev` / `pnpm smoke` | ⚠️ **待本机桌面验证**（见 §5.3） |

### 4.2 下一步：M1（能玩原版）

按依赖顺序拆解，每步都要在 `@mcl/core` 里写测试：

- [ ] **M1-1 离线账户**：生成离线 UUID（`uuid v3(MD5)` 对 `OfflinePlayer:<name>`）、玩家名校验、账户持久化
- [ ] **M1-2 版本元数据**：拉取 version_manifest → 选定版本 → 取 version json
- [ ] **M1-3 资源下载**：libraries（含 natives 解压规则）、client jar、assets（objects 哈希去重）
- [ ] **M1-4 启动装配**：classpath 拼接、JVM 参数（含 `-Djava.library.path`）、主类与游戏参数、cwd 隔离到实例目录
- [ ] **M1-5 启动与日志**：子进程启动、stdout/stderr 落盘（`logs/latest.log` 同款路径）、退出码上报、崩溃日志定位
- [ ] **M1-6 UI 最小闭环**：输入玩家名 → 选版本 → 安装进度 → 启动按钮

**M1 验收**：在干净环境选一个原版版本，能下载完并进入游戏主菜单。

### 4.3 后续里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M2 | Java 运行时自动管理（Temurin）+ AI 面板 MVP | 可配 key 对话、读崩溃日志、报版本状态 |
| M3 | 外置登录（authlib-injector 协议） | 登录/刷新/拉皮肤 |
| M4 | 智能体操作（工具调用）+ mod 加载器 | AI 装 mod / 改配置 / 启动游戏 |
| M5 | 扩展系统（QuickJS 沙箱） | AI 生成扩展并热加载 |
| 后置 | 微软 OAuth、Modrinth/CurseForge、本地推理、Tauri 减重、代码签名 | — |

### 4.4 待办杂项

- [ ] 确定产品正式名（避开 Minecraft 商标）
- [x] 补首个 git commit（`fa77480`，2026-11-18 完成）
- [ ] GUI 冒烟：在桌面会话执行一次 `pnpm dev` 确认窗口
- [ ] 决定是否接入 CI（GitHub Actions：typecheck + test + build）

---

## 5. 运行方式（新会话照抄即可）

### 5.1 标准命令（本机已装 pnpm 时）

```bash
pnpm install     # 安装依赖（含 Electron 二进制）
pnpm test        # core 单元测试
pnpm typecheck   # 三端类型检查
pnpm build       # 全部构建
pnpm dev         # 开发模式（HMR 窗口）
pnpm smoke       # 构建后启动窗口并自动退出（CI 自检）
```

### 5.2 本会话（DSH 沙箱）专用调用方式

PATH 里没有 pnpm，需直调：

```powershell
$node = "C:\Users\Mac\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\Mac\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$env:ELECTRON_CACHE = "C:\Users\Mac\Project\MMCL\.electron-cache"
& $node $pnpm install
```

### 5.3 已知环境限制（不是项目 bug）

- **GUI 无法在 AI 会话内启动**：Electron 的 Chromium 在该会话的受监督进程树下启动即崩；`ELECTRON_RUN_AS_NODE` 模式可正常执行主进程代码，证明产物本身没问题。**窗口验证请在桌面会话做。**
- **Chromium 沙箱启动即崩（已于 2026-11-19 修复，不是环境限制）**：曾经 `pnpm dev` / `pnpm smoke` 启动即退、无任何输出、退出码 `-2147483645`（`0x80000003` STATUS_BREAKPOINT），只有加 `--no-sandbox` 才出窗。真实原因是 pnpm 首次安装的 Electron `dist` 与官方发布包不一致（详见 [INCIDENT-2026-11-19-electron-sandbox.md](./INCIDENT-2026-11-19-electron-sandbox.md)）；用干净的官方 `dist` 覆盖后已恢复正常，**现在不需要 `--no-sandbox`**。再次遇到同症状走该文档第 7 节 SOP，不要先怀疑业务代码。
- **pnpm 11 破坏性变更**：构建脚本白名单键是 `allowBuilds`（对象形式），写在 `pnpm-workspace.yaml`；`package.json` 的 `pnpm` 字段已被忽略。
- **electron 下载镜像**：`.npmrc` 里配了 npmmirror；若换机需确认可达。

**沙箱排障（按可能性排序，2026-11-19 更新）**

1. **Electron 二进制产物不干净（已证实的首要原因）**：`pnpm rebuild electron`，或删掉 `.pnpm\electron@33.4.11` 后重新 `pnpm install`，或直接把官方 zip 解压内容覆盖到 `.pnpm\electron@33.4.11\node_modules\electron\dist`；校验方法与完整证据见 [INCIDENT 文档](./INCIDENT-2026-11-19-electron-sandbox.md)；
2. 安全软件（腾讯电脑管家最可疑）：把 `node_modules\electron\dist\electron.exe` 加入信任区，或临时退出"系统防护"后重试 `pnpm dev`（本次事故已排除此项）；
3. 终端环境：换普通 Windows Terminal（非管理员、非 DSH 内置终端）重试，排除作业对象/提权影响；
4. 都不行再用逃生舱。

**逃生舱脚本（仅限本机开发，禁止用于发布）**

```bash
pnpm dev:ns      # 开发模式：electron-vite dev --noSandbox
pnpm smoke:ns    # 冒烟自检：electron . --smoke-test --no-sandbox
```

代价：关闭 Chromium 的 OS 级沙箱，渲染进程一旦被攻破即等同本机用户权限。本项目只加载本地内容、`contextIsolation` 始终开启，风险可控，但**安装包绝不能带这个开关**；排障完成后应回到 `pnpm dev`。

> 2026-11-19 事故已修复，日常开发请直接用 `pnpm dev`（无需 `--no-sandbox`）。逃生舱保留作下次排障的对照实验手段：若 `dev:ns` 出窗而 `dev` 不出窗，问题就在沙箱层而非业务代码。

### 5.4 冒烟自检机制

`pnpm smoke` → 以 `--smoke-test` 启动 → 窗口就绪后写 `apps/launcher/smoke-ok.txt` 并 `app.quit()`；30s 超时兜底。CI 判断该文件是否存在即可。

---

## 6. 迁移记录

| 日期 | 动作 |
|---|---|
| 2026-11-18 | 项目从 `C:\Users\Mac\Documents\deepseek-harness\default-workspace\mcl` 迁移到 `C:\Users\Mac\Project\mcl`（同卷 rename，含 `.git` 与 `node_modules` 整体搬迁） |
| 2026-11-18 | 迁移后复验：install（168 包，11.5s）/ typecheck / test（5/5）/ build 全部通过；Electron 二进制完好（`node_modules/.pnpm/electron@33.4.11/.../dist/electron.exe`）；新增本交接文档并提交首个 commit `fa77480` |
| 2026-11-19 | 目录更名为 `MMCL`（用户重命名）；桌面会话复验 test/typecheck/build 全绿，但 GUI 启动崩溃，定位为 Chromium 沙箱初始化失败；新增 `dev:ns` / `smoke:ns` 逃生舱脚本与排障文档 |
| 2026-11-19 | 事故闭环：根因是 pnpm 首次安装的 Electron `dist` 与官方发布包不一致；用 `etest` 的干净 `dist` 覆盖后恢复，修复后逐文件取证 73/73 与官方 zip 一致。写入 `docs/INCIDENT-2026-11-19-electron-sandbox.md`，并更正 §5.3 旧结论（不再需要 `--no-sandbox`） |

---

## 7. 许可证纪律（每次加依赖都要过一遍）

- 项目自身 **ISC**；依赖只允许 MIT / Apache-2.0 / BSD；LGPL 仅动态链接；**禁止 GPL/AGPL 代码进入**。
- 参考实现也要小心：HMCL / Prism / PolyMC 是 GPLv3，**只能读协议文档、不能抄代码**；MultiMC 是 Apache-2.0，可作安全参考。
- 无 LICENSE 文件的仓库 = 不可用（默认保留所有权利）。
- 细节见 [DESIGN.md](./DESIGN.md) 第 6 节。
