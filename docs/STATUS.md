# MMCL 项目状态

> 最后更新：2026-11-24 · 本文件是唯一状态源；AGENTS、README、CONTEXT 只链接，不复制。

## 当前阶段

- 已完成：M1~M6；UI 重构 C1~C7。
- 进行中：无；C8 插件页尚未开始。
- 下一步：C8 插件页 → C9 收尾。
- 之后：M4.5 发布准备（electron-builder 打包）。

## 验证

- typecheck：6/6 通过（2026-11-24，AI 环境，bundled tsc --noEmit）。
- test：260 个用例静态存在（core 173 / agent 11 / host 15 / ext-runtime 61）；本机 vitest 未复跑，报 `spawn EPERM`，待桌面复核。
- build / smoke：本轮未跑。

## 版本

- 当前：0.1.0（6 个 package.json lockstep；`@mcl/app` 为产品版本）。
- 计划：C9 完成后统一 0.2.0；M4.5 首个可分发版本再定 0.5.0 / 1.0.0。
- git tag：无。

## 阻塞与风险

- C8 页面尚未实现；ExtManageCard / ExtPanelsCard / ExtReviewCard 已具备但未接入。
- 9 个孤儿卡片待 C9 清理。
- 正版登录、更新检查、自动获取运行时、协议文本、Modrinth 搜索 UI 未实装或后置。
- M4.5 设置 productName 可能改变 userData 路径，打包前需迁移方案。

## 最近变更

- 2026-11-24：文档体系调整——AGENTS 只保留规范，新增 STATUS 作为唯一状态源；README / CONTEXT / DESIGN / UI-DESIGN 改为指针。
- 2026-11-24：对外品牌统一为 MMCL，代码命名空间暂留 mcl。
