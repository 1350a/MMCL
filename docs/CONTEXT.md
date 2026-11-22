# MCL 项目上下文（交接文档）

> 这份文件是项目的"可迁移记忆"：技术栈、关键决策、任务清单、运行方式、迁移记录。
> 新会话、新协作者、未来的我：**先读这份，再读 [DESIGN.md](./DESIGN.md) 的 3/7/8 节**，然后跑 `pnpm test` 确认基线。

最后更新：2026-11-22（M4 代码完成：Fabric + Modrinth 最小接入 + 智能体操作）

---

## 1. 项目身份

| 项 | 值 |
|---|---|
| 代号 | **MCL**（产品正式名待定，务必避开 "Minecraft" 商标） |
| 一句话 | AI 驱动的 Minecraft Java 版第三方启动器 |
| 仓库位置 | `C:\Users\Mac\Project\mcl`（2026-11-18 从 DSH 工作区迁入） |
| 许可证 | **ISC**（见 [LICENSE](../LICENSE)） |
| Git | `main` 分支，首个 commit `fa77480`（2026-11-18 初始化 M0 脚手架） |
| 当前阶段 | **M4 桌面验收通过**（2026-11-22：AI 装 Sodium→启动 fabric-loader-0.20.1-1.20.1 全链路对话实锤；Fabric 安装与网络修复桌面端生效）→ 下一步 M5 扩展系统（QuickJS 沙箱） |
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

### 4.2 M1（能玩原版）——2026-11-20 代码完成

按依赖顺序拆解，每步带 `@mcl/core` 测试（7 个测试文件 42 用例全过）：

- [x] **M1-1 离线账户**：`account.ts` —— `offlineUuid`（MD5 + v3 置位，金标对照本机 JRE 8 `nameUUIDFromBytes` 实测一致）、玩家名校验、`accounts.json` 持久化
- [x] **M1-2 版本元数据**：`manifest.ts` + `version.ts` + `rules.ts` —— manifest_v2 拉取、版本 JSON sha1 校验、inheritsFrom 合并（按 group:artifact 去重）、rules 评估（**实测裁决的官方语义：最后匹配规则决定 + 有 rules 无匹配默认不允许**）
- [x] **M1-3 资源下载**：`install.ts` —— client jar / libraries（rules 过滤 + 旧式 mavenPath 兜底）/ natives classifier 解压（adm-zip，MIT）/ assets objects 按 hash 去重；并发 8、复用 `downloadFile` 续传 + SHA1、已存在校验通过即跳过；`assetBaseUrl` 可配镜像、`skipAssets` 用于冒烟
- [x] **M1-4 启动装配**：`launch.ts` —— 新式 `arguments.{game,jvm}` 与旧式 `minecraftArguments` 双格式；classpath/natives/模板变量（`${auth_player_name}` 等）替换（token 级替换避免含空格路径被拆散）；产出 `LaunchSpec` 不直接 spawn
- [x] **M1-5 Java 检测 + 启动与日志**：`java.ts`（配置路径 → JAVA_HOME → PATH，`-version` 解析）+ `gameProcess.ts`（spawn、stdout/stderr 追加 `logs/latest.log`、退出码单发上报）
- [x] **M1-6 UI 最小闭环**：`main/launcher.ts`（LauncherService 编排）+ IPC 三处同步（settings/account/version/game 四组 11 个 channel + 4 个推送事件）+ App.tsx（账户 → Java 路径 → 版本安装进度条 → 启动/停止 + 日志区）

**已验证（会话内真实数据冒烟，2026-11-20）**：官方清单 → 1.16.5 安装（52 个文件含 client/libraries/natives）→ Java 8 兼容通过 → 装配 → 启动进程存活 60s，日志出现 `Setting user: Notch`、`OpenAL initialized`、纹理图集创建（主菜单加载里程碑）。

**待办**：无。M1 于 2026-11-21 桌面端到端验收通过（1.16.5 启动成功）；崩溃（0x80000003）与 EPERM 已定位为 AI 会话宿主的 Low 完整性标签（见 INCIDENT §11，icacls 重标修复、会话后可能复发）。收尾补丁：损坏 `.part` 自愈、安装完成标记过滤半成品、assets size 快跳校验、安装错误聚合。下一步进入 M2。

**M1 验收**：在干净环境选一个原版版本，能下载完并进入游戏主菜单。

### 4.3 后续里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M2 | Java 运行时自动管理（Temurin）+ AI 面板 MVP | 可配 key 对话、读崩溃日志、报版本状态 | 

> **M2 实现记录（2026-11-21）**：
> - **Java 运行时**：`packages/core/src/runtime.ts` —— Adoptium API（Temurin JRE，sha256 校验复用 `downloadFile` 自愈）→ `extractZip`（自 extractNatives 抽出，带 zip-slip 防护）→ 顶层目录提升到 `runtimes/java-<major>/` → `java -version` 自检 → `.install-ok` 标记。**内置运行时不写任何环境变量**（用户决策）；启动 Java 解析顺序 = 手动路径 → 系统检测 → 内置 runtime，缺失时 UI 引导一键下载。Adoptium Java 16 无 JRE GA（实测空数组），验收版本用 1.20.1（Java 17）。
> - **AI 面板**：新包 `packages/agent`（CJS 对齐 core，禁 electron/react）—— OpenAI 兼容 chat completions 自实现 fetch + SSE + function calling 循环（`client.ts`）、内存会话（`session.ts`，MVP 不落盘）、`AiTool` 形态预留 MCP 对齐。launcher 注入两个工具：`list_versions`（已装版本/内置 runtime/运行状态）、`read_crash_log`（latest.log 尾部 200 行 + crash-reports 最新一份）。设置三字段 baseURL/apiKey/model 存 settings.json（UI 回显掩码）。
> - 测试 59/59（core 53 + agent 6）。
> **M3 实现记录（2026-11-21，代码完成待桌面验收）**：
> - **许可结论**：authlib-injector = AGPL-3.0+ 带**官方 AUTHLIB-INJECTOR 例外条款**（COPYING.md 原文核实）：分发未修改二进制 / HTTP API 交互 / **Java Agent 加载**三种方式均不触发 AGPL 传染，用户确认接受；MMCL 保持 ISC。wiki 文档 CC BY-SA 4.0，只读参考。
> - **协议依据**（官方 wiki en 版逐字核实，非猜测）：`-javaagent:{jar}={API根}` + `-Dauthlibinjector.yggdrasil.prefetched={base64(元数据响应)}`；`${auth_uuid}` 无连字符、`${user_type}`=mojang；authserver 四端点（authenticate/refresh/validate 204|403/invalidate 恒 204）+ ALI 头解析 + 禁止降级 HTTP；jar 分发 API `authlib-injector.yushi.moe/artifact/latest.json`（sha256），BMCLAPI 镜像兜底。
> - **core 新模块**：`yggdrasil.ts`（ALI 解析、四端点、元数据+prefetched、profile/皮肤 textures 解码、15s 超时）；`authlibInjector.ts`（官方→BMCLAPI 逐源回退、sha256 校验、`.install-ok` 版本标记，已装不联网）；`account.ts` 改判别联合（offline/yggdrasil，旧格式自动迁移，yggdrasil uuid 不被离线覆盖）；`launch.ts` 新增 `javaAgent` 注入点 + 认证变量按账户类型分支（离线路径零改动）。
> - **launcher 编排**：外置登录（ALI→元数据→authenticate，多 profile 挂起选择→refresh 绑定）、clientToken 存 settings 长期复用、启动前凭据链 validate→refresh→要求重登、并行备齐 jar+元数据、皮肤头像（textures base64→URL）。IPC 新增 `auth:*` 四 channel + `event:account-changed`，账户 payload 不含 token。
> - 测试 93/93（core 87 + agent 6）。**待验收**：离线回归（1.16.5）、外置登录全流程（服务器可用 yggdrasil-mock 本地起，GPL 仅作测试工具不进代码库）、游戏主界面显示服务器名（注入成功标志）。
| M3 | 外置登录（authlib-injector 协议） | 登录/刷新/拉皮肤 |
| M4 | 智能体操作（工具调用）+ mod 加载器 | AI 装 mod / 改配置 / 启动游戏 |
| M5 | 扩展系统（QuickJS 沙箱） | AI 生成扩展并热加载 |
| 后置 | 微软 OAuth、CurseForge、本地推理、Tauri 减重、代码签名 | — |

> **M4 实现记录（2026-11-22，代码完成待桌面验收）**：
> - **选型**（用户拍板）：mod 加载器 = **Fabric**（Apache-2.0 完全符合许可红线；meta v2 API 直接吐 profile JSON，无安装器实现成本；1.14+ 全版本支持）；mod 来源 = **Modrinth 最小接入**（把后置清单的一小片提前：搜索/版本/下载三端点，匿名可用；CurseForge 仍后置）。被拒：Forge（安装器 binarypatcher 实现成本高）、Quilt（生态小）、NeoForge（1.20.1+ 限定）。
> - **协议核实**（落盘脚本逐字实测 2026-11-22）：fabric-meta `/v2/versions/loader/<game>`（loader 列表）与 `/v2/versions/loader/<game>/<loader>/profile/json`（启动器版本 JSON，`inheritsFrom` 指向原版、mainClass=KnotClient、库条目旧式 name+url，asm/mixin 自带 sha1/size 而 intermediary/fabric-loader 无哈希）；Modrinth `/v2/search`（**返回 `{total_hits, hits}` 对象**）、`/v2/project/<id>/version?game_versions=["x"]&loaders=["y"]`（primary 文件 + hashes.sha1）、cdn.modrinth.com 直下 200。
> - **core 新模块**：`fabric.ts`（loader 列表 / profile 转换——有 sha1 转 `downloads.artifact` 校验下载、无哈希走旧式 url；原版前置检查；装完把**父版本 classifier jar 解压 natives 进 fabric 版本目录**）；`installed.ts`（`resolveInstalledVersion` 沿 inheritsFrom 逐级合并 + client jar 指向继承链根，防环深度上限 8）；`modrinth.ts`（searchMods facets / listModVersions / installModFile——sha1 校验、.part 续传，UA 标识遵守限流规范）；`mods.ts`（list/installLocalMod/removeMod，纯文件名校验防路径穿越）；`optionsTxt.ts`（`key:value` 首冒号切分，原位更新+追加）。
> - **launch.ts**：`AssembleOptions.clientJarPath` 覆盖 client jar（继承版本用父原版 jar，缺省行为不变）。
> - **launcher 编排**：`installFabricVersion`（复用安装锁/取消控制器/进度事件三件套）；mods 与 options 的 IPC 六 channel（`fabric:install`、`mod:list/remove/installLocal`、`config:getOptions/setOptions`），三处同步完成；`launchVersion` 改走 `resolveInstalledVersion`；UI 加「装 Fabric」按钮 + mods 卡片（列表/删除/本地 jar 安装）。
> - **AI 工具扩到 10 个**：M2 的 `list_versions`/`read_crash_log` + M4 的 `launch_game`（缺省单版本自动选）/`install_fabric`（缺省最新稳定 loader）/`search_mods`/`install_mod`（project+gameVersion+loader 必填防装错版本）/`list_mods`/`remove_mod`/`read_config`/`write_config`。system prompt 给出装 mod 标准流程。
> - 测试 **130/130**（core 121 + agent 9）。**会话内真网冒烟通过**：真清单装 1.16.5（skipAssets）→ Fabric 0.20.1（8 库 sha1 校验 + natives 解压）→ 继承链合并装配（classpath 末位=原版 jar、含 fabric-loader）→ Modrinth 搜索 sodium → 真下载主文件 sha1 校验 → options.txt 写读。
> - **网络健壮性（2026-11-22 桌面验收首日修复）**：桌面 `fabric:install` 报 `UND_ERR_BODY_TIMEOUT`（undici 默认 bodyTimeout/headersTimeout 300s），本机实测 maven.fabricmc.net **直连超时/被劫持**、libraries.minecraft.net 返回脏内容（sha1 不符）；BMCLAPI maven（`bmclapi2.bangbang93.com/maven/`，302→中科大教育网镜像）秒级可用。三层修复：① `download.ts` 空闲看门狗（默认 30s 无数据流动即中止本次尝试按网络错误重试，.part 续传保留；自带 signal 与外部取消 signal 分离——沿用 M3 教训）② `install.ts` 下载任务多源回退（`libraryAltBaseUrls`，非末位源 retries=0 一次失败立即换源，末位源保留完整重试）③ fabric 原版安装与 launcher 版本安装均挂 `BMCLAPI_MAVEN_BASE` 回退；fabric/modrinth 的 meta/API fetch 换 `fetchJsonWithRetry`（单次 90s 总超时+重试 1 次，超时转可读中文）——此前 meta fetch 曾挂 414s。冒烟对比：全链路 626s→120s，meta 414s→2.1s，单库最坏等待 300s→30s。
> - **SSRF 防护**：`assertSafeRemoteUrl`（download.ts 导出）校验外部响应携带的下载 URL（仅 http/https，拒绝 localhost/环回/私网/CGNAT/TEST-NET/组播/IPv4-mapped IPv6，注意 WHATWG URL 会把 `::ffff:127.0.0.1` 规范成 `::ffff:7f00:1`）；fabric profile 内嵌库 URL 以 meta 源同 host 为可信边界放行，modrinth `installModFile` 提供 `allowUrlHosts`（测试 fixture / 未来内网镜像口子）。
> - **环境教训**：vitest fixture 服务器 afterAll 里 `await server.close()` 在本沙箱会挂满 60s hookTimeout（keep-alive 空闲连接；裸 node 下 2ms）——改为 `closeAllConnections(); close()` 不阻塞等待。

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
| 2026-11-21 | M1 桌面端到端验收通过（1.16.5 启动）。崩溃（0x80000003）与 EPERM 真根因实锤为 AI 会话宿主（DSH/ZCode）给项目目录打的 Low 完整性标签——非 dist 内容、非 userData 路径；`icacls` 重标 Medium 修复，AI 会话后会复发需重打。INCIDENT 文档 §11 已补复盘并修正 11-19 定性 |
| 2026-11-21 | M1 收尾 + M2 代码完成并提交 main（19e98d4 / 206a496 / c30aea7）：半成品版本防护、assets size 快跳、错误聚合；Java 运行时自动管理（Temurin，内置不写环境变量）；`@mcl/agent` 新包 + AI 面板（OpenAI 兼容自实现，工具 list_versions / read_crash_log）。测试 59/59，桌面端到端验收进行中 |
| 2026-11-21 | M2 两轮验收修复入 main（2a41944 / 4b43074）：AI baseURL 原样前缀、下载重试、Adoptium→TUNA 回退；Java 源改微软 JDK 优先（MIT、aka.ms 短链 + sha256sum.txt）；AI 卡死修复（aiBusy finally 释放、aiSend 失败回滚）。测试 62/62。M2 桌面验收仍待用户（1.20.1 Java 下载上次未闭环） |
| 2026-11-21 | **M3 外置登录代码完成**：core 新增 yggdrasil.ts / authlibInjector.ts，account 判别联合 + launch javaAgent 注入；launcher 外置登录编排 + IPC auth:* + UI 双模式账户卡片。许可结论：AGPL+官方例外条款覆盖（用户确认）。协议依据全部官方 wiki 逐字核实。测试 93/93，typecheck/build 全绿，待桌面验收 |
| 2026-11-21 | 桌面首轮验收反馈修复：`downloadFile` rename 遇 Windows 瞬态文件锁（杀软扫描 `.part` 报 EPERM）自动重试（`renameWithRetry`，EPERM/EBUSY/EACCES ×4 递增延迟）——此锁曾致 authlib-injector 两源下载全失败。外置登录链路实测通（内网 http 服务器 ALI 解析/403 错误解析/凭据链正常）。Java 下载慢（微软 JDK 187MB）用户拍板暂不调整源策略，挂账 M2 收尾。测试 89/89 |
| 2026-11-22 | **M2 收尾四项完成**（用户边验收边清账决策）：① AI 空闲超时（agent 包 `idleTimeoutMs` 默认 60s，无 SSE 增量喂狗即中止，报可读错误）② 会话历史截断（`maxHistoryMessages` 默认 20，发送视图 system+最近 N 条，本地会话保留全量）③ 下载取消（core signal 早已全链路透传，补 launcher 层 AbortController + `version:cancelInstall`/`java:cancelRuntimeInstall` IPC + UI 取消按钮，取消后 `.part` 保留续传）④ 主进程 aiSend 并发锁（多窗口/竞态防交叠）。测试 98/98（core 89 + agent 9），typecheck/build 全绿 |
| 2026-11-22 | 二轮验收反馈修复：yggdrasil TimeoutError 定性——curl 实测演示站 auth-demo.yushi.moe 6 请求挂 3（校园网→Cloudflare 间歇丢包），服务端与协议层无错、程序问题是超时裸抛。修复：yggdrasil.ts 幂等 GET 自动重试 1 次（登录类 POST 不重试防副作用）+ describeNetworkFailure 中文可读错误（超时/连接拒绝/DNS/证书劫持）+ https 失败引导显式 http://（规范禁自动降级）。Java 187MB 下载慢与此同源。测试 core 92/92 |
| 2026-11-22 | 三轮反馈修复真 bug：resolveApiRoot 把 15s 超时 signal 混入"外部取消"判定（combined.aborted）→ 超时被误判主动取消，**重试与错误包装全部失效**（日志实锤裸抛 TimeoutError）。修复 = 超时 signal 与外部 signal 分离（tryFetch 只收外部 signal，15s 由每次 fetchWithTimeout 自带）；"没有任何角色"报错加注册引导。真实链路验证：createRequire 脚本对演示站跑 ALI→元数据→authenticate 两遍全通。同日志确认：AI 401 = 用户 apiKey 过期（配置问题）、取消按钮工作正常。四轮：validate 改幂等重试 1 次 + 凭据链对齐规范（validate 未确认有效含网络失败 → 继续 refresh 续期，refresh 失败才要求重登）——此前 validate 超时会直接终止启动。测试 core 93/93 |
| 2026-11-22 | **M4 代码完成**：core 新增 fabric.ts / installed.ts / modrinth.ts / mods.ts / optionsTxt.ts，launch.ts 加 clientJarPath 覆盖；launcher 加 Fabric/mods/options IPC 六 channel + UI 两卡 + AI 工具扩到 10 个。选型与协议依据见 §4.3 M4 实现记录。测试 130/130（core 121 + agent 9），typecheck/build 全绿，会话内真网冒烟（1.16.5+Fabric+Modrinth 下载）通过。待桌面验收：Fabric 版本启动进主菜单、AI 全流程对话 |
| 2026-11-22 | **桌面验收首日网络修复**：fabric:install 挂死（UND_ERR_BODY_TIMEOUT）定性——maven.fabricmc.net 直连超时、libraries.minecraft.net 劫持脏内容（两者 sha1 实锤），BMCLAPI maven（302→中科大镜像）秒级可用。修复：下载空闲看门狗（30s 默认，替代 undici 300s 默认）、installVersion 多源回退（BMCLAPI_MAVEN_BASE，fabric 与 launcher 版本安装均挂）、meta/API fetch 超时+重试（fetchJsonWithRetry）、assertSafeRemoteUrl SSRF 校验。测试 139/139（core 130 + agent 9）。冒烟 626s→120s。待桌面复验 |
| 2026-11-22 | **M4 桌面验收通过**：AI 全流程对话实锤——用户「帮我装 Sodium」→ AI list_versions 发现 1.20.1 已有 fabric-loader → **主动向用户确认目标版本**（system prompt 生效）→ search_mods → install_mod（Sodium 0.5.13+mc1.20.1）→ 提示「原版不加载模组，用 fabric-loader 版本启动」→ 启动成功、mods 落盘确认。Fabric 安装修复与 Java 17 runtime（M2 挂账项）均实际闭环。未覆盖：write_config 桌面对话未走到（不阻塞）。M4 收尾 commit，下一步 M5 扩展系统 |

---

## 7. 许可证纪律（每次加依赖都要过一遍）

- 项目自身 **ISC**；依赖只允许 MIT / Apache-2.0 / BSD；LGPL 仅动态链接；**禁止 GPL/AGPL 代码进入**。
- 参考实现也要小心：HMCL / Prism / PolyMC 是 GPLv3，**只能读协议文档、不能抄代码**；MultiMC 是 Apache-2.0，可作安全参考。
- 无 LICENSE 文件的仓库 = 不可用（默认保留所有权利）。
- 细节见 [DESIGN.md](./DESIGN.md) 第 6 节。
