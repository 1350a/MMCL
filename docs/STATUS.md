# MMCL 项目状态

> 最后更新：2026-11-24 · 本文件是唯一状态源；AGENTS、README、CONTEXT 只链接，不复制。

## 当前阶段

- 已完成：M1~M6；UI 重构 C1~C7。
- 进行中：C8 插件页已实现，待桌面端到端验收。
- 下一步：C8 验收 → C9 收尾（删除 6 个孤儿卡片 + 文档终稿）。
- 之后：M4.5 发布准备（electron-builder 打包）。

## C8 插件页（2026-11-24 实现）

- 语义：AI `generate_extension` 生成即保存；默认写 `.disabled` 不装载；插件页手动启用/停用；设置页「AI 生成的扩展自动加载」默认关闭。
- 流水线：`submit` / `loadInstalled` / `enable` / `disable` / `remove`；启动时无标记装载、有标记只登记。
- IPC 六通道：`ext:listPanels`、`ext:panel-action`、`ext:list`、`ext:remove`、`ext:enable`、`ext:disable`；删除 `ext:pending/approve/reject` 与 `event:ext-pending`。
- UI：新增 `ExtensionsPage`（扩展管理 + 扩展面板）；删除 `ExtReviewCard` 与占位页 `PlaceholderPage`。
- 测试：`pipeline.test.ts` 重写为 12 例（保存 / 自动加载 / 启停 / 启动恢复 / 卸载 / 清单过滤）。

## 验证

- typecheck：6/6 通过（2026-11-24，AI 环境，bundled tsc --noEmit；删除孤儿页后复跑）。
- test：全仓静态 259 例（core 173 / agent 11 / host 15 / ext-runtime 60）；本机 vitest 仍报 `spawn EPERM`（esbuild 子进程），未复跑，待桌面复核。
- build / smoke：本轮未跑；C8 端到端待桌面验收。

## 版本

- 当前：0.1.0（6 个 package.json lockstep；`@mcl/app` 为产品版本）。
- 计划：C9 完成后统一 0.2.0；M4.5 首个可分发版本再定 0.5.0 / 1.0.0。
- git tag：无。

## 阻塞与风险

- C8 尚未桌面端到端验收：生成 → 保存 → 启用/停用 → 重启保持 → 卸载，以及自动加载开关。
- 6 个孤儿卡片待 C9 清理：AccountsCard / InstancesCard / AiCard / VersionsCard / ModsCard / JavaCard。
- 正版登录、更新检查、自动获取运行时、协议文本、Modrinth 搜索 UI 未实装或后置。
- M4.5 设置 productName 可能改变 userData 路径，打包前需迁移方案。

## 最近变更

- 2026-11-24：C8 插件页落地——取消待审提案，改为生成即保存、默认不装载、手动启停 + 设置自动加载；六 IPC 通道；ExtensionsPage。
- 2026-11-24：文档体系调整——AGENTS 只保留规范，新增 STATUS 作为唯一状态源；README / CONTEXT / DESIGN / UI-DESIGN 改为指针。
- 2026-11-24：对外品牌统一为 MMCL，代码命名空间暂留 mcl。
