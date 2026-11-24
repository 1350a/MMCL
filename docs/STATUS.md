# MMCL 项目状态

> 最后更新：2026-11-24 · 本文件是唯一状态源；AGENTS、README、CONTEXT 只链接，不复制。

## 当前阶段

- 已完成：M1~M6；UI 重构 C1~C8；C9 收尾（清理 / 文档 / 0.2.0）已落地。
- C8 已通过桌面启动冒烟；完整验收链（生成 → 保存 → 启用 → 重启保持 → 停用 → 卸载）建议最终复核。
- 下一步：M4.5 发布准备（electron-builder 已跑通，产出 0.1.0-alpha.1 便携包；后续补图标 / 签名 / 安装器）。
- 之后候选：微软正版登录、更新服务器 / 自更新、Modrinth 搜索 UI。

## C8 插件页（2026-11-24 实现）

- 语义：AI `generate_extension` 生成即保存；默认写 `.disabled` 不装载；插件页手动启用 / 停用；设置页「AI 生成的扩展自动加载」默认关闭。
- 流水线：`submit` / `loadInstalled` / `enable` / `disable` / `remove`；启动时无标记装载、有标记只登记。
- IPC 六通道：`ext:listPanels`、`ext:panel-action`、`ext:list`、`ext:remove`、`ext:enable`、`ext:disable`；删除 `ext:pending/approve/reject` 与 `event:ext-pending`。
- UI：新增 `ExtensionsPage`（扩展管理 + 扩展面板）；删除 `ExtReviewCard` 与占位页 `PlaceholderPage`。
- 测试：`pipeline.test.ts` 重写为 12 例（保存 / 自动加载 / 启停 / 启动恢复 / 卸载 / 清单过滤）。
- 验收：桌面启动冒烟通过；完整端到端链待最终复核。

## C9 收尾（2026-11-24）

- 删除 6 个孤儿卡片：AccountsCard / InstancesCard / AiCard / VersionsCard / ModsCard / JavaCard，共 371 行。
- 删除 `App.css` 死样式 `.java-need` / `.ai-config` / `.ext-code`，共 26 行；合计清理 397 行。
- 六个 `package.json` 统一 `0.1.0 → 0.2.0`；未打 git tag。
- 文档：AGENTS 只保留规范；README / CONTEXT / DESIGN / UI-DESIGN 指向本文件，不复制状态。

## Alpha 打包（2026-11-24）

- 使用 electron-builder 26.18.0 + 本机缓存的 Electron 33.4.11 打出 `win-unpacked` 便携目录，压缩为 `MMCL-0.1.0-alpha.1-win-x64.zip`。
- 复现：根目录 `pnpm package:alpha`（输出 `.release/dist/win-unpacked`）；无网络/证书问题时追加 `-c.electronDist=<本地 Electron dist>`。
- asar 内已包含 QuickJS wasm、esbuild 与四个 `@mcl/*` 包；M4.5 原先担心的 singlefile 变体不再必要。
- 本轮未签名、使用默认 Electron 图标；AI 环境无法完整启动 GUI，桌面需复核启动与扩展生成。

## 验证

- typecheck：6/6 通过（2026-11-24，AI 环境，bundled tsc --noEmit；C9 清理后复跑）。
- test：全仓静态 259 例（core 173 / agent 11 / host 15 / ext-runtime 60）；本机 vitest 仍报 `spawn EPERM`（esbuild 子进程），未复跑，待桌面复核。
- build / smoke：本轮未跑；待桌面 `pnpm test` 与 `pnpm smoke` 最终复核。

## 版本

- 当前：0.1.0-alpha.1（6 个 package.json lockstep；`@mcl/app` 为产品版本；alpha 预发布）。
- 下一里程碑：M4.5 首个可分发版本再定 0.5.0 / 1.0.0。
- git tag：无。

## 阻塞与风险

- C8 完整端到端链尚未由桌面最终确认：生成 → 保存 → 启用 / 停用 → 重启保持 → 卸载，以及自动加载开关。
- 正版登录、更新检查、自动获取运行时、协议文本、Modrinth 搜索 UI 未实装或后置。
- M4.5 设置 productName 可能改变 userData 路径，打包前需显式迁移方案。
- 渲染层仍无自动化测试；UI 行为依赖桌面冒烟。

## 最近变更

- 2026-11-24：alpha 打包——electron-builder + 本地 Electron 33.4.11 产出 0.1.0-alpha.1 便携包；六包版本由 0.2.0 改为 0.1.0-alpha.1。
- 2026-11-24：C9 收尾——删除 6 个孤儿卡片与 3 段死 CSS，六包版本统一 0.2.0。
- 2026-11-24：C8 插件页落地——取消待审提案，改为生成即保存、默认不装载、手动启停 + 设置自动加载；六 IPC 通道；ExtensionsPage。
- 2026-11-24：文档体系调整——AGENTS 只保留规范，新增 STATUS 作为唯一状态源；README / CONTEXT / DESIGN / UI-DESIGN 改为指针。
- 2026-11-24：对外品牌统一为 MMCL，代码命名空间暂留 mcl。
