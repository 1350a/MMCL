# MCL 设计文档（v0.1）

- 项目代号：MCL（产品名待定，注意避开 Minecraft 商标）
- 阶段：M0（架构验证）
- 日期：2026-11-18
- 项目许可：ISC

## 1. 产品定位

MCL 是 **AI 驱动的 Minecraft Java 版第三方启动器**。与现有启动器的核心差异：AI 是启动器的一等公民——玩家通过与 AI 对话完成"自定义启动器"的操作（装 mod、改配置、分析崩溃日志），最终由 AI 生成扩展代码并在沙箱中热加载。

合规提醒：非 Mojang 官方产品；产品名不使用 Minecraft 商标；不内置任何受版权保护的资源与模型权重。

## 2. 范围

### 2.1 MVP（M1–M3）

1. 版本与 Java 运行时自动管理（Mojang version manifest + Adoptium API）；
2. 离线登录 + 外置登录（Authlib-Injector 协议）；
3. 最小 AI：客户端可配置 API key / base URL / 模型；对话 + 崩溃日志分析 + 版本状态查询。

### 2.2 愿景（M4 及以后）

- 智能体操作启动器（装 mod / 改配置 / 启动游戏）；
- AI 生成扩展 + 沙箱热加载；
- 微软账号登录、Modrinth / CurseForge 整合、本地模型推理。

### 2.3 首版明确不做

微软正版认证（后置）、皮肤/披风系统、整合包商店、内置模型权重。

## 3. 技术栈

| 层次 | 选型 | 许可 |
|---|---|---|
| 桌面壳 | Electron 33 | MIT |
| 构建 | electron-vite 2 + Vite 5 | MIT |
| UI | React 18 + TypeScript | MIT |
| 核心库 | 纯 TS 包 `@mcl/core`（不依赖 Electron） | ISC |
| AI 层 | `@mcl/agent`（M2 引入，同样解耦） | ISC |
| 扩展运行时 | QuickJS 沙箱（M5 引入） | MIT |
| 测试 | Vitest | MIT |
| 包管理 | pnpm workspaces | MIT |

选型理由见 ADR-001。要点：个人新手、AI 驱动优先、Windows 优先但不锁死、ISC + 宽松依赖。全栈一种语言（TS/JS），AI 辅助开发与 LLM SDK 生态最强；Electron 体积/内存的代价用"核心解耦、未来可换 Tauri 壳"对冲。

被否决方案：Tauri（Rust 学习曲线）、Avalonia（生态小、AI 资料少）、Qt（LGPL）、Java/Compose（JRE 体积、GPLv2+CE 心理负担）。

## 4. 架构

```
┌──────────────────────────────────────────────────┐
│ 渲染进程 React UI（无 Node 能力）                   │
│   └─ window.mcl.* 白名单 API                      │
├──────────────────────────────────────────────────┤
│ preload（contextBridge，沙箱内）                    │
├──────────────────────────────────────────────────┤
│ 主进程（薄壳）：IPC 路由 + 窗口生命周期              │
│   └─ 调用 @mcl/core / @mcl/agent                  │
├──────────────────────────────────────────────────┤
│ @mcl/core（纯 TS：下载/校验/账户/版本/启动）         │
│ @mcl/agent（AI 层：协议适配/工具/会话，M2）          │
│ @mcl/ext-runtime（QuickJS 沙箱，M5）               │
└──────────────────────────────────────────────────┘
```

依赖规则：

1. `@mcl/core` 与 `@mcl/agent` **禁止 import electron / react** —— 可单测、可 CLI 驱动；
2. 渲染进程无 Node 能力，只能经 preload 白名单 IPC 访问主进程；
3. 主进程 = 薄壳：IPC 路由 + 窗口生命周期 + 调用 core；
4. 未来 `@mcl/ext-runtime` 只能经主进程授权的 API 面访问系统（权限白名单）。

当前目录结构：

```
mcl/
├─ apps/launcher/          Electron 壳（主进程 / preload / React UI）
├─ packages/core/          纯 TS 核心库（下载、校验；后续加账户/版本/启动）
├─ docs/DESIGN.md          本文档
└─ pnpm-workspace.yaml     monorepo 配置
```

## 5. 关键设计

### 5.1 AI 统一 OpenAI 兼容协议

设置页只暴露三个字段：baseURL + apiKey + model。一次适配同时覆盖 OpenAI / DeepSeek / Kimi / GLM / Ollama（本地）。不内置模型权重 → 无权重许可风险、无体积负担。调用层自实现 HTTP + SSE，不引入 SDK 依赖。

### 5.2 三层愿景 = 工具集演化

```ts
interface AiTool {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
  handler: (args: unknown) => Promise<string>
}
```

工具路线：M2 `{ list_versions, read_crash_log }` → M4 `{ install_mod, set_config, launch_game }` → M5 `{ generate_extension }`。接口格式预留向 MCP 对齐。

### 5.3 扩展系统（M5）

QuickJS（MIT）沙箱；扩展语言 TS/JS（与全栈一致）；AI 生成 → 用户审核 → 热加载；权限白名单（文件系统范围、网络域名）。

### 5.4 外置登录

按 Authlib-Injector **协议规范**（公开文档）独立实现 Yggdrasil 扩展接口。红线：其参考实现为 GPLv3，不得搬运代码。

### 5.5 下载与校验

fetch + Range 断点续传（`.part` 中间文件，校验通过后 rename 生效）；SHA1 校验（Mojang 清单格式）；版本资源逐文件并发下载（并发上限 8）。

### 5.6 安全基线

contextIsolation + sandbox + nodeIntegration:false；window.open 拦截转外链；IPC 参数校验；下载内容校验后才生效。

## 6. 许可证治理

### 6.1 红线

1. 项目本体 ISC；
2. 依赖限定 MIT/Apache/BSD/ISC；LGPL 仅限动态链接且需评审（当前清单无）；
3. 禁止搬运 GPL 代码：HMCL、Prism、PolyMC、Authlib-Injector 参考实现等；
4. 无许可证的公开仓库 = 保留所有权利 = 不可用；
5. 不内置受限模型权重（AI 走用户自配 endpoint）；
6. 参考 MultiMC（Apache-2.0）时保留版权声明。

### 6.2 当前依赖

electron（MIT）、electron-vite（MIT）、vite（MIT）、react（MIT）、typescript（Apache-2.0）、vitest（MIT）、@vitejs/plugin-react（MIT）。运行时下载的 Java 为 Temurin（GPLv2+Classpath Exception，可再分发）；mod 加载器仅下载不链接，无传染。

### 6.3 流程

新增依赖前 `pnpm licenses list` 扫描 + 人工复核依赖树；无法确认许可的包不进项目。

## 7. 路线图

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| M0 | monorepo + 窗口 + IPC + core 下载/校验 + 单测 | 本阶段：smoke 自检通过 |
| M1 | 离线登录（离线 UUID）+ 版本安装 + 原版启动 + 日志捕获 | 能玩原版 |
| M2 | Java 自动管理 + AI 面板 MVP | 可配 key 对话 + 读日志 + 版本状态 |
| M3 | 外置登录 | Authlib-Injector 协议可登录/刷新/拉皮肤 |
| M4 | 智能体操作 + mod 加载器 | AI 装 mod / 改配置 / 启动游戏 |
| M5 | 扩展系统 | QuickJS 沙箱 + AI 生成扩展热加载 |
| 后置 | 微软 OAuth、Modrinth/CurseForge、本地推理、Tauri 减重、代码签名 | — |

## 8. 决策记录

- **ADR-001** Electron 而非 Tauri：新手友好 + AI 驱动生态 + 全栈一种语言；core/agent 解耦保留未来换 Tauri 壳的迁移路径。
- **ADR-002** AI 层只实现 OpenAI 兼容协议，由用户自配 endpoint。
- **ADR-003** `@mcl/core` 暂以 CJS 发布（Electron 主进程兼容），后续随 ESM main 迁移。
- **ADR-004** 扩展运行时选 QuickJS（备选 Lua/WASM）。

## 9. 风险与开放问题

- Windows 未签名 exe 的 SmartScreen 警告（代码签名证书成本）；
- 微软 OAuth client id 使用政策；
- CurseForge API key 政策（后置）；
- 外置登录服务器生态与合规；
- Electron 内存占用（观察，必要时 Tauri 迁移）；
- 产品命名与商标。
