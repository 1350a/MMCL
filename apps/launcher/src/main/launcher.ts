import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  assembleLaunch,
  assertJavaCompatible,
  authenticate,
  BMCLAPI_MAVEN_BASE,
  createInstance,
  deleteInstance,
  detectJava,
  ensureAuthlibInjector,
  ensureDefaultInstance,
  fetchFabricLoaderVersions,
  fetchProfileWithSkin,
  fetchServerMeta,
  fetchVersionJson,
  fetchVersionManifestWithFallback,
  findVersionEntry,
  generateClientToken,
  getInstance,
  installFabric,
  installLocalMod,
  installRuntime,
  installVersion,
  invalidate,
  JavaVersionMismatchError,
  launchGame,
  listInstalledRuntimes,
  listInstances,
  listMods,
  loadAccounts,
  mergeVersionJson,
  pickRuntime,
  readOptionsTxt,
  refresh,
  removeMod,
  resolveApiRoot,
  resolveInstalledVersion,
  saveAccounts,
  updateInstance,
  validate,
  validatePlayerName,
  writeOptionsTxt
} from '@mcl/core'
import type {
  Account,
  AuthenticateResponse,
  InstanceMeta,
  JavaAgentOptions,
  ModFileInfo,
  OfflineAccount,
  ProfileWithSkin,
  RuntimeInfo,
  JavaInfo,
  VersionJson,
  VersionManifest,
  YggdrasilAccount,
  YgProfile
} from '@mcl/core'
import { ChatClient, ChatSession } from '@mcl/agent'
import type { ChatMessage } from '@mcl/agent'
import { ComponentHost } from '@mcl/host'
import type { PanelState } from '@mcl/host'
import {
  createCapabilityProviders,
  ensureDemoExtension,
  ExtensionPipeline,
  EXTENSION_API_DOC,
  initExtRuntime,
  scanExtensions
} from '@mcl/ext-runtime'
import type { CapabilityRuntime, ExtensionSummary, PendingExtension, SubmitResult } from '@mcl/ext-runtime'
import { createAiToolsComponent } from './components/aiTools'
import type { AiToolsDeps } from './components/aiTools'

export interface RemoteVersion {
  id: string
  type: string
  releaseTime: string
}

export interface SettingsPayload {
  javaPath: string
  javaMajor?: number
  javaRaw?: string
}

export interface AiConfigPayload {
  baseUrl: string
  apiKeyMasked: string
  model: string
  configured: boolean
}

export interface AiSettings {
  baseUrl: string
  apiKey: string
  model: string
}

/** 外置登录结果：直接成功，或返回待选角色列表（token 暂存主进程内存）。 */
export type YggdrasilLoginResult =
  | { status: 'ok' }
  | { status: 'select-profile'; profiles: Array<{ id: string; name: string }> }

/** 渲染进程可见的账户信息（不含 token）。 */
export type AccountPayload = OfflineAccount | Omit<YggdrasilAccount, 'accessToken' | 'clientToken'>

interface SettingsFile {
  javaPath?: string
  ai?: AiSettings
  /** 本启动器实例的 clientToken（首次登录时生成，长期复用）。 */
  clientToken?: string
}

/** 启动器运行时状态与编排：IPC 路由层只调用这里的方法。 */
export class LauncherService {
  private readonly settingsPath: string
  private manifest: VersionManifest | null = null
  private installing = false
  private javaInstalling = false
  /** 当前游戏进程与对应版本 id（单实例）。 */
  private game: { handle: { process: ChildProcess; logFile: string }; versionId: string } | null = null
  private logBuffer: string[] = []

  /** 组件宿主（M5-1）：内建功能以组件形式注册，与扩展走同一能力授予面。 */
  private readonly components: ComponentHost
  /** 能力面运行时（M5-4）：面板/钩子/fs 代理/net 代理的宿主实现。 */
  private readonly capabilities: CapabilityRuntime
  /** 扩展流水线（M5-5）：AI 提案 → 一致性检查 → 审核 → 热装载/卸载。 */
  private readonly pipeline: ExtensionPipeline
  /** 默认实例迁移（M6）：首启创建 main / 旧裸目录补元数据；实例相关 IPC 与启动都等它。 */
  private readonly instanceReady: Promise<unknown>
  /** AI 会话落盘文件（重启恢复对话，MVP 收尾）。 */
  private readonly aiSessionPath: string

  constructor(
    readonly rootDir: string,
    private readonly send: (channel: string, payload: unknown) => void
  ) {
    this.settingsPath = join(rootDir, 'settings.json')
    this.capabilities = createCapabilityProviders({
      send: this.send,
      instanceDirFor: (id) => join(rootDir, 'instances', id)
    })
    this.components = new ComponentHost({
      providers: this.capabilities.providers,
      onChange: (info) => console.log(`[components] ${info.id} → ${info.state}${info.reason ? `（${info.reason}）` : ''}`)
    })
    this.pipeline = new ExtensionPipeline({
      extensionsDir: join(rootDir, 'extensions'),
      host: this.components,
      notify: (channel, payload) => this.send(channel, payload)
    })
    this.instanceReady = ensureDefaultInstance(rootDir).catch((err) => {
      console.error('[instances] 默认实例初始化失败：', err)
      throw err instanceof Error ? err : new Error(String(err))
    })
    this.aiSessionPath = join(rootDir, 'ai-session.json')
    this.components.setCoEffect('game.notRunning', true)
    this.components.setCoEffect('ai.configured', this.isAiConfigured())
    this.components.register(createAiToolsComponent(this.aiToolsDeps()))
    // M5-3：扩展装载管线（WASM 预热 → demo 落盘 → 扫描装载；失败不阻塞启动器，仅少扩展）
    void initExtRuntime()
      .then(async () => {
        const extensionsDir = join(this.rootDir, 'extensions')
        await ensureDemoExtension(extensionsDir)
        const { loaded, errors } = await scanExtensions(extensionsDir)
        for (const e of errors) console.error('[extensions]', e.dir, '→', e.reason)
        // 逐个注册：单个扩展注册失败（如工具重名）不中止后续扩展
        for (const ext of loaded) {
          try {
            this.components.register(ext.component)
          } catch (err) {
            console.error('[extensions] 注册失败', ext.manifest.id, '→', err)
          }
        }
      })
      .catch((err) => console.error('[components] 沙箱扩展装载失败：', err))
  }

  private readSettings(): SettingsFile {
    try {
      return JSON.parse(readFileSync(this.settingsPath, 'utf8')) as SettingsFile
    } catch {
      return {}
    }
  }

  private async writeSettings(settings: SettingsFile): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true })
    await fs.writeFile(this.settingsPath, JSON.stringify(settings, null, 2))
  }

  async getSettings(): Promise<SettingsPayload> {
    const { javaPath } = this.readSettings()
    const payload: SettingsPayload = { javaPath: javaPath ?? '' }
    if (javaPath) {
      try {
        const java = await detectJava(javaPath)
        payload.javaMajor = java.majorVersion
        payload.javaRaw = java.raw
      } catch {
        // 配置的 java 探测失败：返回空版本信息，由 UI 提示
      }
    }
    return payload
  }

  /** 保存 Java 路径并立即探测，返回当前设置（含探测结果）。 */
  async setJavaPath(javaPath: string): Promise<SettingsPayload> {
    if (typeof javaPath !== 'string') throw new Error('invalid java path')
    if (javaPath.trim() === '') {
      await this.writeSettings({})
      return this.getSettings()
    }
    const java = await detectJava(javaPath)
    await this.writeSettings({ javaPath })
    return { javaPath, javaMajor: java.majorVersion, javaRaw: java.raw }
  }

  async getAccount(): Promise<Account | null> {
    const accounts = await loadAccounts(this.rootDir)
    return accounts[0] ?? null
  }

  /** 渲染进程可见的账户信息（剥离 accessToken/clientToken）。 */
  async getAccountPayload(): Promise<AccountPayload | null> {
    const account = await this.getAccount()
    if (!account) return null
    if (account.kind === 'yggdrasil') {
      const { accessToken: _a, clientToken: _c, ...rest } = account
      return rest
    }
    return account
  }

  /** 保存离线账户（单玩家 MVP：覆盖式单账户）。 */
  async saveAccount(name: string): Promise<OfflineAccount> {
    if (typeof name !== 'string') throw new Error('invalid account name')
    validatePlayerName(name)
    const account: OfflineAccount = { kind: 'offline', name, uuid: '' }
    await saveAccounts(this.rootDir, [account])
    return { kind: 'offline', name, uuid: '' }
  }

  // ---- 外置登录（M3：authlib-injector / Yggdrasil）----

  /** 等待角色选择的挂起态：登录成功但服务端要求选择 profile 时暂存 token（仅内存）。 */
  private pendingYgAuth: { apiRoot: string; serverName?: string; auth: AuthenticateResponse } | null = null

  private async clientToken(): Promise<string> {
    const settings = this.readSettings()
    if (settings.clientToken) return settings.clientToken
    const token = generateClientToken()
    await this.writeSettings({ ...settings, clientToken: token })
    return token
  }

  /**
   * 外置登录：ALI 解析地址 → 取服务器元数据 → 密码认证。
   * 服务端已绑定 profile 时直接完成；多 profile 时挂起等待用户选择（selectYggdrasilProfile）。
   */
  async yggdrasilLogin(serverInput: string, username: string, password: string): Promise<YggdrasilLoginResult> {
    if (typeof serverInput !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
      throw new Error('invalid login params')
    }
    const apiRoot = await resolveApiRoot(serverInput)
    const { meta } = await fetchServerMeta(apiRoot)
    const clientToken = await this.clientToken()
    const auth = await authenticate(apiRoot, { username, password, clientToken })

    if (auth.selectedProfile) {
      await this.completeYggdrasilLogin(apiRoot, meta.meta.serverName, auth, auth.selectedProfile)
      return { status: 'ok' }
    }
    if (auth.availableProfiles.length === 0) {
      throw new Error('该账户在认证服务器上没有任何角色：请先在该服务器注册并创建角色，或使用服务器提供的测试账号')
    }
    this.pendingYgAuth = { apiRoot, serverName: meta.meta.serverName, auth }
    return {
      status: 'select-profile',
      profiles: auth.availableProfiles.map((p) => ({ id: p.id, name: p.name }))
    }
  }

  /** 用户从角色列表中选定后：refresh 绑定 profile → 落盘。 */
  async selectYggdrasilProfile(profileId: string): Promise<void> {
    const pending = this.pendingYgAuth
    if (!pending) throw new Error('没有待选择角色的登录')
    const profile = pending.auth.availableProfiles.find((p) => p.id === profileId)
    if (!profile) throw new Error('角色不存在')
    const refreshed = await refresh(pending.apiRoot, {
      accessToken: pending.auth.accessToken,
      clientToken: pending.auth.clientToken,
      selectedProfile: { id: profile.id, name: profile.name }
    })
    const selected = refreshed.selectedProfile ?? profile
    this.pendingYgAuth = null
    await this.completeYggdrasilLogin(pending.apiRoot, pending.serverName, refreshed, selected)
  }

  /** 用认证结果组装 YggdrasilAccount 覆盖保存（单活跃账户），并推送给 UI。 */
  private async completeYggdrasilLogin(
    apiRoot: string,
    serverName: string | undefined,
    auth: { accessToken: string; clientToken: string },
    profile: YgProfile
  ): Promise<void> {
    const account: YggdrasilAccount = {
      kind: 'yggdrasil',
      name: profile.name,
      uuid: profile.id, // 规范序列化：无连字符 UUID
      apiRoot,
      accessToken: auth.accessToken,
      clientToken: auth.clientToken,
      ...(serverName ? { serverName } : {})
    }
    await saveAccounts(this.rootDir, [account])
    this.send('event:account-changed', this.toPayload(account))
  }

  /** 登出：Yggdrasil 先尽力吊销 token，然后清空账户。 */
  async logoutAccount(): Promise<void> {
    const account = await this.getAccount()
    if (account?.kind === 'yggdrasil') {
      await invalidate(account.apiRoot, {
        accessToken: account.accessToken,
        clientToken: account.clientToken
      }).catch(() => undefined) // 吊销失败不阻塞登出
    }
    await saveAccounts(this.rootDir, [])
    this.send('event:account-changed', null)
  }

  /** 当前账户的皮肤信息（Yggdrasil 账户；离线账户无皮肤返回 null）。 */
  async fetchCurrentSkin(): Promise<ProfileWithSkin | null> {
    const account = await this.getAccount()
    if (account?.kind !== 'yggdrasil') return null
    return fetchProfileWithSkin(account.apiRoot, account.uuid)
  }

  /**
   * 启动前凭据链（启动器技术规范）：validate 成功 → 照常启动；validate 未确认有效
   * （含网络失败）→ 继续 refresh 续期；refresh 失败 → 要求重登。
   * validate 网络超时不代表 token 无效，不能直接终止启动。
   */
  private async ensureYggdrasilCredential(account: YggdrasilAccount): Promise<YggdrasilAccount> {
    let ok = false
    try {
      ok = await validate(account.apiRoot, {
        accessToken: account.accessToken,
        clientToken: account.clientToken
      })
    } catch {
      ok = false // 网络失败：走 refresh 兜底
    }
    if (ok) return account
    let refreshed: Awaited<ReturnType<typeof refresh>>
    try {
      refreshed = await refresh(account.apiRoot, {
        accessToken: account.accessToken,
        clientToken: account.clientToken
      })
    } catch {
      throw new Error(
        `无法确认外置登录凭据（${account.serverName ?? account.apiRoot}）：认证服务器暂时连不上或凭据已失效，请稍后重试或重新登录`
      )
    }
    const updated: YggdrasilAccount = { ...account, accessToken: refreshed.accessToken }
    await saveAccounts(this.rootDir, [updated])
    return updated
  }

  private toPayload(account: Account): AccountPayload {
    if (account.kind === 'yggdrasil') {
      const { accessToken: _a, clientToken: _c, ...rest } = account
      return rest
    }
    return account
  }

  private async ensureManifest(): Promise<VersionManifest> {
    if (!this.manifest) {
      // 官方 launchermeta 失败（校园网劫持/不可达）回退 BMCLAPI 镜像（M6，与库下载多源回退同思路）
      this.manifest = await fetchVersionManifestWithFallback()
    }
    return this.manifest
  }

  async listRemoteVersions(): Promise<RemoteVersion[]> {
    const manifest = await this.ensureManifest()
    return manifest.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }))
  }

  async listInstalledVersions(): Promise<string[]> {
    const dir = join(this.rootDir, 'versions')
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const ids: string[] = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const versionDir = join(dir, e.name)
        const has = async (p: string): Promise<boolean> =>
          fs.access(p).then(() => true, () => false)
        const hasJson = await has(join(versionDir, `${e.name}.json`))
        const hasMarker = await has(join(versionDir, '.install-ok'))
        if (hasJson && hasMarker) {
          ids.push(e.name)
        } else if (hasJson && (await has(join(versionDir, `${e.name}.jar`)))) {
          // 旧安装（无标记时代）：json + jar 都在即视为已装，补标记迁移
          await fs.writeFile(join(versionDir, '.install-ok'), 'migrated\n')
          ids.push(e.name)
        }
        // 其余（json 而无 jar / 无标记且无 jar）视为半成品，不进列表
      }
      return ids.sort()
    } catch {
      return []
    }
  }

  /** 按清单 id 拉取版本 JSON（含 inheritsFrom 递归合并，M1 原版一般无继承）。 */
  private async resolveVersionJson(id: string): Promise<VersionJson> {
    const manifest = await this.ensureManifest()
    const entry = findVersionEntry(manifest, id)
    if (!entry) throw new Error(`版本 ${id} 不在清单中`)
    const json = await fetchVersionJson(entry.url, entry.sha1)
    if (json.inheritsFrom) {
      const parent = await this.resolveVersionJson(json.inheritsFrom)
      return mergeVersionJson(json, parent)
    }
    return json
  }

  /** 版本安装 / 运行时下载的取消控制（M2 收尾：下载取消）。 */
  private installAbort: AbortController | null = null
  private javaInstallAbort: AbortController | null = null

  /** 安装一个版本（并发锁：同一时间一个安装任务），进度经事件推送；可经 cancelInstallVersion 取消。 */
  async installVersion(id: string): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid version id')
    if (this.installing) throw new Error('已有安装任务在进行中')
    this.installing = true
    const controller = new AbortController()
    this.installAbort = controller
    try {
      const versionJson = await this.resolveVersionJson(id)
      await installVersion(versionJson, this.rootDir, {
        onProgress: (p) => this.send('event:install-progress', p),
        signal: controller.signal,
        // 官方库源在校园网实测会被劫持/不可达，失败回退 BMCLAPI 镜像（官方源仍优先）
        libraryAltBaseUrls: [BMCLAPI_MAVEN_BASE]
      })
      this.send('event:install-done', { id, ok: true })
    } catch (err) {
      const cancelled = controller.signal.aborted
      const message = cancelled ? '安装已取消' : (err as Error).message
      this.send('event:install-done', { id, ok: false, error: message })
      throw cancelled ? new Error('安装已取消') : err
    } finally {
      this.installing = false
      this.installAbort = null
    }
  }

  /** 取消进行中的版本安装（已下 .part 保留，下次安装续传）。 */
  cancelInstallVersion(): void {
    this.installAbort?.abort()
  }

  /** 实例目录（mods/options.txt/saves/logs 都在这里）。 */
  private instanceDirFor(instanceId: string): string {
    return join(this.rootDir, 'instances', instanceId)
  }

  // ---- 多实例（M6，DESIGN.md §5.7）----

  /** 实例清单（等默认实例迁移完成）。 */
  async listInstancesPayload(): Promise<InstanceMeta[]> {
    await this.instanceReady
    return listInstances(this.rootDir)
  }

  /**
   * 新建实例（id 缺省自动生成；versionId 给了就校验已安装并绑定）。
   * 单独暴露 createInstancePayload 而非直接转发 core：版本绑定校验依赖启动器状态。
   */
  async createInstancePayload(input: { id?: string; name: string; versionId?: string }): Promise<InstanceMeta> {
    await this.instanceReady
    const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : `inst-${Date.now().toString(36)}`
    const versionId = typeof input.versionId === 'string' && input.versionId !== '' ? input.versionId : undefined
    if (versionId) await this.assertVersionInstalled(versionId)
    return createInstance(this.rootDir, { id, name: input.name, ...(versionId ? { versionId } : {}) })
  }

  /** 给实例绑定已安装版本（versionId 可后续更换）。 */
  async setInstanceVersion(instanceId: string, versionId: string): Promise<InstanceMeta> {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    if (typeof versionId !== 'string' || versionId.length === 0) throw new Error('invalid version id')
    await this.instanceReady
    await this.assertVersionInstalled(versionId)
    return updateInstance(this.rootDir, instanceId, { versionId })
  }

  /**
   * 删除实例（整个实例目录不可逆删除，UI 侧确认弹窗把关）。
   * 游戏运行中一律拒绝（单游戏约束，避免删到正在运行的 gameDir）；
   * 删除 main 后下次启动 ensureDefaultInstance 会重建空 main。
   * 刻意不提供 AI 工具入口：AI 触发存档删除是脚枪。
   */
  async deleteInstancePayload(instanceId: string): Promise<void> {
    if (this.game) throw new Error('游戏正在运行，请先停止再删除实例')
    await this.instanceReady
    await deleteInstance(this.rootDir, instanceId)
  }

  /** 断言版本已安装（绑定版本时的即时反馈，避免启动时才发现绑错）。 */
  private async assertVersionInstalled(versionId: string): Promise<void> {
    const installed = await this.listInstalledVersions()
    if (!installed.includes(versionId)) {
      throw new Error(`版本 ${versionId} 未安装（已安装：${installed.join('、') || '（无）'}）`)
    }
  }

  /** 启动实例绑定的版本（需实例已绑版本 + 已保存账户）。日志经事件推送并缓冲。 */
  async launchInstance(instanceId: string): Promise<{ logFile: string }> {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    if (this.game) throw new Error('已有游戏在运行')
    await this.instanceReady
    const instance = await getInstance(this.rootDir, instanceId)
    const id = instance.versionId
    if (!id) throw new Error(`实例 ${instance.name}（${instanceId}）尚未绑定版本：请先在实例卡选择版本，或让 AI 用 create_instance 创建`)
    let account = await this.getAccount()
    if (!account) throw new Error('请先创建账户')
    // 解析继承链（fabric 等子版本）：合并父版本库/参数，client jar 取继承链根的
    const resolved = await resolveInstalledVersion(this.rootDir, id)
    const versionJson = resolved.json

    // 外置登录：先走凭据链（validate → refresh → 重登提示），再备齐 authlib-injector jar 与预取元数据
    let javaAgent: JavaAgentOptions | undefined
    if (account.kind === 'yggdrasil') {
      account = await this.ensureYggdrasilCredential(account)
      const [injector, meta] = await Promise.all([
        ensureAuthlibInjector(this.rootDir),
        fetchServerMeta(account.apiRoot)
      ])
      javaAgent = { jarPath: injector.jarPath, apiRoot: account.apiRoot, prefetched: meta.prefetched }
    }

    const java = await this.resolveJava(versionJson)

    const spec = assembleLaunch(versionJson, {
      javaPath: java.path,
      account,
      gameDir: this.instanceDirFor(instanceId),
      rootDir: this.rootDir,
      launcherName: 'MCL',
      launcherVersion: '0.1.0',
      ...(javaAgent ? { javaAgent } : {}),
      clientJarPath: resolved.clientJarPath
    })

    // M5-4：启动前钩子（按注册顺序执行；拒绝即抛、返回值按序追加 JVM 参数）
    const extraJvmArgs = await this.capabilities.runBeforeLaunch({ versionId: id, jvmArgs: [] })
    if (extraJvmArgs.length > 0) spec.jvmArgs.push(...extraJvmArgs)

    this.logBuffer = []
    const handle = launchGame(spec, {
      onLog: (line, source) => {
        this.logBuffer.push(`[${source}] ${line}`)
        if (this.logBuffer.length > 5000) this.logBuffer.shift()
        this.send('event:game-log', { line, source })
      },
      onExit: (code) => {
        this.game = null
        this.components.setCoEffect('game.notRunning', true)
        void this.capabilities
          .runAfterExit({ versionId: id, code })
          .catch((err) => console.error('[hooks] 退出钩子执行失败：', err))
        this.send('event:game-exit', { code })
      },
      onError: (err) => this.send('event:game-log', { line: `进程错误: ${err.message}`, source: 'stderr' })
    })
    this.game = { handle, versionId: id }
    this.components.setCoEffect('game.notRunning', false)
    return { logFile: handle.logFile }
  }

  /**
   * Java 解析顺序：手动配置路径（detectJava 内部回退 JAVA_HOME/PATH）→ 版本不符时
   * 用内置 runtime（pickRuntime 取满足 major 的最小版本）→ 都没有则抛引导错误。
   */
  private async resolveJava(versionJson: VersionJson): Promise<JavaInfo> {
    const { javaPath } = this.readSettings()
    const java = await detectJava(javaPath || undefined)
    try {
      assertJavaCompatible(java, versionJson)
      return java
    } catch (err) {
      if (!(err instanceof JavaVersionMismatchError)) throw err
      const required = err.requiredMajorVersion
      const runtimes = await listInstalledRuntimes(this.rootDir)
      const builtin = pickRuntime(runtimes, required)
      if (builtin) {
        return { path: builtin.javaPath, majorVersion: builtin.major, raw: `builtin-${builtin.major}` }
      }
      throw new Error(
        `启动 ${versionJson.id} 需要 Java ${required}：请在 Java 卡片一键下载内置运行时（约 45MB），或手动配置对应版本的 javaPath`
      )
    }
  }

  /** 内置运行时列表。 */
  listRuntimes(): Promise<RuntimeInfo[]> {
    return listInstalledRuntimes(this.rootDir)
  }

  /** 下载内置 Java 运行时（Temurin JRE，约 45MB），进度经事件推送；可经 cancelRuntimeInstall 取消。 */
  async installRuntimeFor(major: number): Promise<RuntimeInfo> {
    if (!Number.isInteger(major) || major < 8) throw new Error(`invalid java major: ${major}`)
    if (this.javaInstalling) throw new Error('已有运行时下载在进行中')
    this.javaInstalling = true
    const controller = new AbortController()
    this.javaInstallAbort = controller
    try {
      const info = await installRuntime(this.rootDir, major, {
        onProgress: (p) => this.send('event:java-install-progress', p),
        signal: controller.signal
      })
      return info
    } catch (err) {
      throw controller.signal.aborted ? new Error('运行时下载已取消') : err
    } finally {
      this.javaInstalling = false
      this.javaInstallAbort = null
    }
  }

  /** 取消进行中的内置运行时下载。 */
  cancelRuntimeInstall(): void {
    this.javaInstallAbort?.abort()
  }

  // ---- Fabric 加载器与 mod 管理（M4）----

  /**
   * 为已安装的原版版本安装 Fabric 加载器（loaderVersion 缺省取最新稳定版）。
   * 复用版本安装锁与取消控制器；进度/完成事件与版本安装共用同一组 channel。
   */
  async installFabricVersion(gameVersion: string, loaderVersion?: string): Promise<{ versionId: string }> {
    if (typeof gameVersion !== 'string' || gameVersion.length === 0) throw new Error('invalid game version')
    if (this.installing) throw new Error('已有安装任务在进行中')
    const wanted = typeof loaderVersion === 'string' && loaderVersion.trim() !== '' ? loaderVersion.trim() : undefined
    const chosen =
      wanted ?? (await fetchFabricLoaderVersions(gameVersion)).find((v) => v.stable)?.version
    if (!chosen) throw new Error(`没有可用的 Fabric loader${wanted ? `（${wanted}）` : ''}`)
    this.installing = true
    const controller = new AbortController()
    this.installAbort = controller
    try {
      const result = await installFabric(this.rootDir, gameVersion, chosen, {
        onProgress: (p) => this.send('event:install-progress', p),
        signal: controller.signal
      })
      this.send('event:install-done', { id: result.versionId, ok: true })
      return { versionId: result.versionId }
    } catch (err) {
      const cancelled = controller.signal.aborted
      const message = cancelled ? '安装已取消' : (err as Error).message
      // 失败时拿不到确定的 fabric id，用占位 id 只为 UI 展示错误
      this.send('event:install-done', { id: `fabric-loader-?-${gameVersion}`, ok: false, error: message })
      throw cancelled ? new Error('安装已取消') : err
    } finally {
      this.installing = false
      this.installAbort = null
    }
  }

  listModsPayload(instanceId: string): Promise<ModFileInfo[]> {
    return listMods(this.instanceDirFor(instanceId))
  }

  removeModFile(instanceId: string, filename: string): Promise<void> {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    if (typeof filename !== 'string') throw new Error('invalid mod filename')
    return removeMod(this.instanceDirFor(instanceId), filename)
  }

  installModFromLocal(instanceId: string, jarPath: string): Promise<string> {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    if (typeof jarPath !== 'string') throw new Error('invalid mod path')
    return installLocalMod(this.instanceDirFor(instanceId), jarPath)
  }

  readGameOptions(instanceId: string): Promise<Array<{ key: string; value: string }>> {
    return readOptionsTxt(this.instanceDirFor(instanceId))
  }

  writeGameOptions(instanceId: string, entries: Record<string, string>): Promise<Array<{ key: string; value: string }>> {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    if (typeof entries !== 'object' || entries === null) throw new Error('invalid options entries')
    return writeOptionsTxt(this.instanceDirFor(instanceId), entries)
  }

  stopGame(): void {
    this.game?.handle.process.kill()
  }

  readGameLog(): string {
    return this.logBuffer.join('\n')
  }

  isGameRunning(): boolean {
    return this.game !== null
  }

  // ---- AI 面板（M2-2）----

  private aiSession: ChatSession | null = null
  /** 主进程侧并发锁：多窗口 / 渲染层竞态下防两条请求交叠（M2 收尾）。 */
  private aiRequesting = false

  getAiConfig(): AiConfigPayload {
    const { ai } = this.readSettings()
    const configured = !!(ai?.baseUrl && ai?.apiKey && ai?.model)
    return {
      baseUrl: ai?.baseUrl ?? '',
      apiKeyMasked: ai?.apiKey ? `${ai.apiKey.slice(0, 6)}...${ai.apiKey.slice(-4)}` : '',
      model: ai?.model ?? '',
      configured
    }
  }

  async setAiConfig(ai: AiSettings): Promise<AiConfigPayload> {
    if (
      typeof ai !== 'object' ||
      typeof ai.baseUrl !== 'string' ||
      typeof ai.apiKey !== 'string' ||
      typeof ai.model !== 'string'
    ) {
      throw new Error('invalid AI config')
    }
    const settings = this.readSettings()
    settings.ai = { baseUrl: ai.baseUrl.trim(), apiKey: ai.apiKey.trim(), model: ai.model.trim() }
    await this.writeSettings(settings)
    // 配置变化：重置会话（客户端参数已变），并更新协效应（组件按需激活/停用）
    this.aiSession = null
    this.components.setCoEffect('ai.configured', !!(settings.ai.baseUrl && settings.ai.apiKey && settings.ai.model))
    return this.getAiConfig()
  }

  /** AI 是否已完整配置（协效应 ai.configured 的真值来源）。 */
  private isAiConfigured(): boolean {
    const { ai } = this.readSettings()
    return !!(ai?.baseUrl && ai?.apiKey && ai?.model)
  }

  /** 内建 AI 工具组件的状态依赖适配（私有状态收敛为组件可见的最小面）。 */
  private aiToolsDeps(): AiToolsDeps {
    return {
      listInstalledVersions: () => this.listInstalledVersions(),
      listRuntimes: () => this.listRuntimes(),
      javaPath: () => this.readSettings().javaPath ?? '',
      isGameRunning: () => this.isGameRunning(),
      instanceDirFor: (instanceId) => this.instanceDirFor(instanceId),
      listInstancesPayload: () => this.listInstancesPayload(),
      createInstancePayload: (input) => this.createInstancePayload(input),
      launchInstance: (instanceId) => this.launchInstance(instanceId),
      installFabricVersion: (gameVersion, loaderVersion) => this.installFabricVersion(gameVersion, loaderVersion),
      listModsPayload: (instanceId) => this.listModsPayload(instanceId),
      removeModFile: (instanceId, filename) => this.removeModFile(instanceId, filename),
      readGameOptions: (instanceId) => this.readGameOptions(instanceId),
      writeGameOptions: (instanceId, entries) => this.writeGameOptions(instanceId, entries),
      submitExtensionProposal: (manifest, code) => this.pipeline.submit(manifest, code)
    }
  }

  private aiSystemPrompt(): string {
    return [
      '你是 Minecraft 第三方启动器 MCL 的内置助手。',
      '回答简洁、可操作；涉及版本与运行状态时优先调用工具查询而不是猜测。',
      '用户环境为 Windows；游戏实例在启动器数据目录 instances/<实例 id> 下（多实例：list_instances 查看、create_instance 新建）。每个实例绑定一个已安装版本，launch_game 按实例启动；装 mod / 改配置默认作用于 main 实例，可用 instanceId 参数指定其他实例。',
      '装 mod 流程：确认目标实例已绑定（或绑定）合适版本 → install_fabric 装 Fabric 加载器 → search_mods（带 gameVersion+loader）→ install_mod（project/gameVersion/loader 必填）→ 建议用户启动对应实例（launch_game）。',
      '改游戏设置用 read_config / write_config（options.txt，游戏下次启动生效）；启动游戏用 launch_game。',
      '对启动器或 mod 有不确定的版本兼容问题时，先向用户确认再操作。',
      '用户请你写启动器扩展（自定义工具/面板/钩子等）时，用 generate_extension 提交，规范如下：',
      EXTENSION_API_DOC
    ].join('\n')
  }

  /** 发送一条用户消息：主进程跑完整 tool 循环，流式增量与最终回复经事件推送。主进程侧并发锁（M2 收尾）。 */
  async aiSend(text: string): Promise<{ content: string }> {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('empty message')
    if (this.aiRequesting) throw new Error('已有 AI 请求进行中，请等待当前回复完成')
    const { ai } = this.readSettings()
    if (!ai?.baseUrl || !ai?.apiKey || !ai?.model) {
      throw new Error('请先在 AI 卡片配置 baseURL / apiKey / model')
    }
    this.aiRequesting = true
    try {
      if (!this.aiSession) {
        this.aiSession = new ChatSession(this.aiSystemPrompt())
        // 重启恢复：落盘历史回灌（system prompt 每次启动重建，不落盘）
        const saved = this.readAiSessionHistory()
        if (saved.length > 0) this.aiSession.restoreHistory(saved)
      }
      this.aiSession.addUser(text)

      const client = new ChatClient({ baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model })
      try {
        const result = await client.send(this.aiSession.messages(), this.components.getTools(), {
          onDelta: (t) => this.send('event:ai-delta', { text: t }),
          // 工具活动（参数流式生成 / 执行 / 完成）推给渲染层：干活过程可视化
          onToolEvent: (e) => this.send('event:ai-tool', e)
        })
        this.aiSession.addAssistant(result.content)
        await this.persistAiSession()
        return { content: result.content }
      } catch (err) {
        // 失败也要通知 UI 恢复输入状态（401/网络错误等），并回退本条用户消息
        const message = err instanceof Error ? err.message : String(err)
        this.send('event:ai-error', { message })
        this.aiSession.messages().pop() // 移除刚加的 user 消息，会话不留悬空
        throw err
      }
    } finally {
      this.aiRequesting = false
    }
  }

  aiClear(): void {
    this.aiSession?.clear()
    void fs.rm(this.aiSessionPath, { force: true }).catch(() => undefined)
  }

  /** 渲染层回灌：落盘的会话历史（重启后恢复聊天显示，不含 system）。 */
  aiHistoryPayload(): Array<{ role: 'user' | 'assistant'; text: string }> {
    return this.readAiSessionHistory()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.content ?? '' }))
  }

  /** 读取落盘的会话历史（不存在/损坏返回空）。 */
  private readAiSessionHistory(): ChatMessage[] {
    try {
      const raw = JSON.parse(readFileSync(this.aiSessionPath, 'utf8')) as { messages?: unknown }
      return Array.isArray(raw.messages) ? (raw.messages as ChatMessage[]) : []
    } catch {
      return []
    }
  }

  /** 会话落盘（保留最近 100 条；失败不阻塞对话）。 */
  private async persistAiSession(): Promise<void> {
    if (!this.aiSession) return
    const messages = this.aiSession.exportHistory().slice(-100)
    try {
      await fs.writeFile(this.aiSessionPath, JSON.stringify({ messages }, null, 2))
    } catch (err) {
      console.error('[ai] 会话落盘失败：', err)
    }
  }

  /** 扩展面板清单（渲染层初始拉取）。 */
  listPanels(): PanelState[] {
    return this.capabilities.getPanels()
  }

  /** 扩展面板按钮点击 → 面板 onAction 回调（桥回沙箱）。 */
  panelAction(panelId: string, action: string): Promise<void> {
    return this.capabilities.panelAction(panelId, action)
  }

  // ---- 扩展审核与管理（M5-5/6）：转发流水线 ----

  /** AI 提交扩展提案（generate_extension 工具入口）。 */
  submitExtensionProposal(manifest: unknown, code: string): Promise<SubmitResult> {
    return this.pipeline.submit(manifest, code)
  }

  /** 当前待审核提案（渲染层初始拉取）。 */
  extPending(): PendingExtension | null {
    return this.pipeline.getPending()
  }

  /** 批准并热装载。 */
  extApprove(): Promise<SubmitResult> {
    return this.pipeline.approve()
  }

  /** 拒绝提案。 */
  extReject(): SubmitResult {
    return this.pipeline.reject()
  }

  /** 卸载扩展（注销 + 删目录）。 */
  extRemove(id: string): Promise<SubmitResult> {
    return this.pipeline.remove(id)
  }

  /** 已注册扩展清单（渲染层初始拉取）。 */
  extList(): ExtensionSummary[] {
    return this.pipeline.list()
  }
}

/** 类型引用保留：JavaInfo 供未来 UI 显示探测详情。 */
export type { JavaInfo }
