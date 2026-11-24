# MMCL — AI 驱动的 Minecraft 启动器

**简体中文**

> 非 MINECRAFT 官方产品。未经 MOJANG 或 MICROSOFT 批准，也不与 MOJANG 或 MICROSOFT 关联。

MMCL ( My Minecraft Launcher ) 是一款 AI 驱动的 Minecraft Java 版第三方启动器。AI 是产品设计的核心理念，也是其与现有启动器的核心差异：AI 是启动器的一等公民——玩家可以在启动器中通过与 AI 对话来实现日志分析，设置调整等功能，同时支持"自定义启动器"的操作，由 AI 生成扩展代码并在沙箱中热加载。

## 当前状态

开发中，尚未发布安装包。当前阶段、验证结果与下一步见 [docs/STATUS.md](docs/STATUS.md)。

## 文档

- [docs/STATUS.md](docs/STATUS.md) —— 当前状态（唯一状态源）
- [docs/CONTEXT.md](docs/CONTEXT.md) —— 交接、决策与历史
- [docs/DESIGN.md](docs/DESIGN.md) —— 架构、许可与路线图
- [docs/UI-DESIGN.md](docs/UI-DESIGN.md) —— UI 交互
- [AGENTS.md](AGENTS.md) —— 协作规范

## 快速开始

环境要求：Node ≥ 20、pnpm。

```bash
pnpm install     # 安装依赖（含 Electron 二进制）
pnpm typecheck   # 类型检查（全部包 + launcher）
pnpm test        # 全仓单元测试
pnpm build       # 全部构建
pnpm dev         # 开发模式（HMR）
pnpm smoke       # 冒烟自检：构建后启动窗口并自动退出
```

## 目录结构

```文件树
apps/launcher/        Electron 壳（主进程 / preload / React UI）
packages/core/        纯 TS 核心库
packages/agent/       AI 层
packages/host/        组件宿主
packages/ext-runtime/ 扩展沙箱
```

## 冒烟自检

`pnpm smoke` 构建后以 `--smoke-test` 参数启动窗口；主进程在窗口就绪时写入 `apps/launcher/smoke-ok.txt` 并自动退出，适合 CI/脚本验证。

注意：在受限或无人值守的自动化环境（如 AI 会话沙箱）中 Chromium 可能无法启动 GUI（进程树监督导致 electron.exe 启动即崩溃），这属于环境限制而非项目问题；请在本机桌面会话执行 `pnpm dev` 或 `pnpm smoke` 验证窗口。

## 故障排查

窗口起不来时先看 [docs/INCIDENT-2026-11-19-electron-sandbox.md](docs/INCIDENT-2026-11-19-electron-sandbox.md)：那个事故的症状是"启动即退、退出码 `-2147483645`、只有添加 `--no-sandbox` 能出窗"

## LICENSE

ISC

依赖仅接受 MIT / Apache-2.0 / BSD / ISC；GPL/AGPL 严禁，无 LICENSE 的仓库视为不可用。详见 [docs/DESIGN.md](docs/DESIGN.md) §6。

> ISC 其实和 MIT 没啥区别，选择这个许可证只是作者的个性化选择 :P
