# MCL — AI 驱动的 Minecraft 启动器

> 非 Mojang 官方产品。项目许可：ISC。

MCL 是 AI 驱动的 Minecraft Java 版第三方启动器。目标是让玩家通过与 AI 对话完成启动器定制：装 mod、改配置、分析崩溃日志，最终由 AI 生成扩展代码并在沙箱中热加载。

## 当前状态

M0 架构验证版：monorepo + Electron 窗口 + IPC 自检 + 核心库（下载/校验）与单元测试。

## 快速开始

环境要求：Node ≥ 20、pnpm。

```bash
pnpm install     # 安装依赖（含 Electron 二进制）
pnpm test        # core 单元测试
pnpm build       # 全部构建
pnpm dev         # 开发模式（HMR）
pnpm smoke       # 冒烟自检：构建后启动窗口并自动退出
```

## 目录结构

```
apps/launcher/        Electron 壳（主进程 / preload / React UI）
packages/core/        纯 TS 核心库（下载、校验；后续加账户/版本/启动）
packages/agent/       AI 层（M2 引入）
packages/ext-runtime/ 扩展沙箱（M5 引入）
docs/CONTEXT.md       项目上下文 / 交接文档（技术栈、决策、任务清单、运行方式）
docs/DESIGN.md        设计文档（选型、架构、许可证、路线图）
```

> 接手或恢复会话时先读 [docs/CONTEXT.md](docs/CONTEXT.md)，那里有完整的技术栈、已定决策和任务进度。

## 冒烟自检

`pnpm smoke` 构建后以 `--smoke-test` 参数启动窗口；主进程在窗口就绪时写入 `apps/launcher/smoke-ok.txt` 并自动退出，适合 CI/脚本验证。

注意：在受限或无人值守的自动化环境（如 AI 会话沙箱）中 Chromium 可能无法启动 GUI（进程树监督导致 electron.exe 启动即崩溃），这属于环境限制而非项目问题；请在本机桌面会话执行 `pnpm dev` 或 `pnpm smoke` 验证窗口。

## 许可证纪律

ISC 项目；依赖限宽松许可；不搬运 GPL 代码；无许可证仓库不可用。详见 `docs/DESIGN.md` 第 6 节。

> ISC 其实和 MIT 没啥区别，选择这个许可证只是作者的个性化选择 :P
