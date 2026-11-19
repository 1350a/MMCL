# 事故复盘：Electron 启动即崩（STATUS_BREAKPOINT，0x80000003）

- 发生日期：2026-11-19
- 影响范围：M0 脚手架在本机的全部 GUI 运行（`pnpm dev` / `pnpm smoke` / `electron .`）
- 状态：**已修复**，未进入任何发布产物
- 一句话结论：`node_modules` 里 Electron 的 `dist` 目录首次安装产物与官方发布包不一致，Chromium 沙箱初始化阶段即 `CHECK` 失败直接 `__debugbreak`；用一份干净的官方 `dist` 覆盖后恢复。
- 一句话修复：用 `C:\Users\Mac\etest\node_modules\electron\dist` 整目录覆盖项目的同路径目录。

---

## 1. 现象

| 项 | 值 |
|---|---|
| 表现 | 双击/命令启动后无窗口、无任何 stdout/stderr，进程立即退出 |
| 退出码 | `-2147483645`（有符号 32 位）= `0x80000003`，NTSTATUS `STATUS_BREAKPOINT` |
| 加重参数 | `--enable-logging=stderr --v=1` 仍无日志（死在 Chromium 日志系统初始化之前） |
| 唯一有效开关 | `--no-sandbox` → 立刻正常出窗 |
| 系统 | Windows 10 22H2（10.0.19045.7725），腾讯电脑管家系统防护 + Windows Defender，非管理员账户 |
| 运行时 | Electron 33.4.11，pnpm 11.28.5 安装，`electron_mirror` = npmmirror |

旁证：崩溃时连 userData 都没写（`C:\Users\Mac\AppData\Roaming\@mcl\app\Local State` 的 mtime 停在 11-18 13:31），而 11-19 正常跑过的 `etest` 应用同名文件在 12:41 被更新 → 崩在"创建配置目录"之前，属于极早期失败。

## 2. 排查与逐项排除

| 假设 | 做法 | 结果 |
|---|---|---|
| 应用代码问题（preload / renderer / IPC） | 写最小窗口（不含本项目任何代码，`data:text/html`） | 同样崩 → 排除 |
| GPU / GPU 子进程 | `--disable-gpu`、`--disable-gpu-sandbox` | 同样崩 → 排除 |
| 主程序被篡改或损坏 | `electron.exe` 与 npm 直装副本比 SHA256 | 完全一致 `1925f358e7f0e9675a5ac4198fb076613f0db318da56d388799a97be74a5b19c`（188,784,128 B）→ 主程序排除 |
| IFEO 镜像劫持 | 查 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\electron.exe` 与 `chrome.exe` | 两个键都不存在 → 排除 |
| HVCI / 内核隔离 | `Win32_DeviceGuard.SecurityServicesRunning` | `0` → 排除 |
| 提权终端（管理员令牌） | 查 `IsInRole(Administrator)` | `False` → 排除 |
| 环境变量污染 | 查 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `COMPAT_LAYER` | 全为空 → 排除 |
| stdio 继承方式 | 继承父进程 / 最小环境变量 / 管道三种启动 | 退出码相同 → 排除 |
| userData 路径含 `@`（包名 `@mcl/app`） | 检查 `%APPDATA%\@mcl\app` | 目录存在且结构完整（Cache / GPUCache / Local State / Preferences / Network …）→ 排除 |
| 父进程干涉（AI 会话的进程树监督） | 改为桌面会话 `Start-Process -Wait` 独立启动 | 仍然崩 → 与本会话无关 |

## 3. 决定性矩阵（`Start-Process -Wait -PassThru`，桌面会话实测）

| 编号 | 启动内容 | 额外参数 | 退出码 | 是否出窗 |
|---|---|---|---|---|
| R0 | 最小窗口（不含本项目代码，沙箱开启） | — | `-2147483645` | 否 |
| R1 | 本项目 `apps/launcher` | — | `-2147483645` | 否 |
| R2 | 本项目 | `--disable-gpu-sandbox` | `-2147483645` | 否 |
| R3 | 本项目 | `--disable-gpu` | `-2147483645` | 否 |
| R4 | 本项目 | `--no-sandbox` | `0` | **是** |

五个变体里唯一生效的自变量就是"Chromium OS 沙箱开/关"，且 R0 已把应用代码摘干净 → 问题在**沙箱初始化层**，不在业务代码、不在 GPU、不在安全软件 hook（否掉常见猜测）。

## 4. 修复动作（用户执行，1 步）

把 `C:\Users\Mac\etest\node_modules\electron\dist` 整个目录覆盖到项目的 Electron 目录：

```
C:\\Users\\Mac\\Project\\MMCL\\node_modules\\.pnpm\\electron@33.4.11\\node_modules\\electron\\dist
```

之后 `pnpm dev` 正常出窗，**不再需要 `--no-sandbox`**。

> 路径提醒：pnpm 的真实二进制在 `.pnpm\electron@33.4.11\node_modules\electron\dist`，`node_modules\electron\dist` 只是链到那里的软链/Junction。覆盖与校验都要针对 `.pnpm` 下的真实目录。

## 5. 修复后取证（工作态是干净的官方包）

- 官方 zip：`C:\Users\Mac\AppData\Local\electron\Cache\503bc5800d2c74b70eecdd0422ba25b13b1670c4c9b7ef85a9a997f7c9c28c4a\electron-v33.4.11-win32-x64.zip`
- 解压到 `C:\Users\Mac\mcl-probe3\zipcheck`，与项目 `dist`、`etest` 的 `dist` 三份逐文件比 sha256：
  - 文件数：zip 73 / 项目 73 / etest 73
  - **差异文件数 = 0**
- 即：现在运行的 `dist` 与官方发布包逐字节一致，事故状态没有残留。

## 6. 根因研判（为什么只能给到"高度可能"）

- 崩溃时被哈希过的文件里，`electron.exe`、`ffmpeg.dll`、`icudtl.dat`、`v8_context_snapshot.bin`、`chrome_100_percent.pak`、`resources.pak`、`snapshot_blob.bin` 与干净副本**一致**。
- 所以坏点只可能落在其余 66 个文件之一：`locales\*.pak`、`resources\default_app.asar`、`d3dcompiler_47.dll`、`libEGL.dll`、`libGLESv2.dll`、`vk_swiftshader.dll`、`vulkan-1.dll` 等。
- 候选解释 A（最可能）：首次 `pnpm install` 的 Electron 解压产物不完整/错位 —— 那次安装确实因沙箱 `EPERM` 中断过一次、随后重跑，属于 pnpm / 镜像层的偶发脏产物。
- 候选解释 B：文件系统属性差异 —— `Copy-Item` 重建文件后 ACL / Mark-of-the-Web 等元数据变了，而 Chromium 沙箱 broker 恰好在这种属性下启动失败。
- 无法定论的原因：旧 `dist` 已被覆盖；pnpm 缓存 `C:\Users\Mac\AppData\Local\pnpm-cache\v12` 只有 `metadata` / `metadata-full`，没有可回放的内容库；也没有留转储。
- 但对处置没有影响：A、B 指向同一个动作（换成干净官方 `dist`），且该动作已实测有效。

## 7. 复发处置 SOP（约 5 分钟）

1. **定性**：`--no-sandbox` 能出窗 + 退出码 `-2147483645` → 判定为沙箱层问题，先别改代码。
2. **校验**：`Expand-Archive` 官方 zip 到临时目录，与 `.pnpm\...\electron\dist` 比对文件数与 sha256。
3. **重装二进制**（三选一，从轻到重）：
   ```bash
   pnpm rebuild electron
   # 或：删掉 .pnpm\electron@33.4.11 后 pnpm install
   # 或：直接把官方 zip 解压内容覆盖进 dist
   ```
   若怀疑缓存本身脏：删 `%LOCALAPPDATA%\electron\Cache` 后重装，让它重新下载。
4. **复验**：`pnpm dev`（**不带** `--no-sandbox`）出窗；`pnpm smoke` 生成 `apps/launcher/smoke-ok.txt`。
5. 仍崩才升级到"安全软件 / 环境"排查（把 `electron.exe` 加信任区、换普通终端），最后才动逃生舱 `dev:ns`。

## 8. 经验教训

- **GUI 程序的退出码必须用 `Start-Process -Wait -PassThru` 取**。PowerShell 的 `&` 对 GUI 子系统进程不等待，`$LASTEXITCODE` 不会被赋值，紧接着的 `Test-Path` 会跑在窗口打开之前 → 曾产生"exit=0 但没出窗"的整轮假数据。
- **中间人会引入混淆变量**。第一轮探针用 `node` 的 `child_process.spawn` + 管道启动，全部变体都崩，容易被误读成"应用代码无辜"；真正干净的结论来自"同一父进程、同一 stdio、只改一个参数"的矩阵。
- **多行命令粘进终端会被截断**（曾把路径切成 `...node_mod`）。排障脚本要落成 `.ps1` 文件，再用单行 `powershell -NoProfile -ExecutionPolicy Bypass -File ...` 调用。
- **崩溃早于日志初始化时**，`--enable-logging` 拿不到任何信息，只能靠"换二进制 / 换参数"做二分。
- **`--no-sandbox` 是诊断工具，不是修复方案**。它出窗只证明问题在沙箱层；长期带这个参数跑开发，等于把渲染进程被攻破的代价放大到本机用户权限。

## 9. 遗留风险与后续加固

- [ ] CI 加一步：`install` 后校验 Electron `dist` 与官方 zip 一致（防首次安装脏产物，属 pnpm/镜像层偶发问题）。
- [ ] 发布配置中禁止出现 `--no-sandbox`（`AGENTS.md` 已约束）；`dev:ns` / `smoke:ns` 仅限本机开发。
- [ ] 再次出现同类症状，先走第 7 节 SOP，不要先怀疑业务代码。
- [x] `docs/CONTEXT.md` §5.3 的旧结论（"本机环境限制、只能 `--no-sandbox`"）已更正。

## 10. 相关文件

- `apps/launcher/src/main/index.ts`（带 `--no-sandbox` 时打印警告）
- `apps/launcher/package.json`、根 `package.json`（`dev:ns` / `start:ns` / `smoke:ns`）
- `docs/CONTEXT.md` §5.3（排障入口）、§6（迁移与事故记录表）
- 排障残留脚本：`C:\Users\Mac\mcl-probe3\t2.ps1`（R0–R4 矩阵）、`C:\Users\Mac\mcl-probe3\zipcheck`（官方 zip 解压件）
