import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  assembleLaunch,
  assertJavaCompatible,
  authenticate,
  BMCLAPI_MAVEN_BASE,
  detectJava,
  ensureAuthlibInjector,
  fetchFabricLoaderVersions,
  fetchProfileWithSkin,
  fetchServerMeta,
  fetchVersionJson,
  fetchVersionManifest,
  findVersionEntry,
  generateClientToken,
  installFabric,
  installLocalMod,
  installRuntime,
  installVersion,
  invalidate,
  JavaVersionMismatchError,
  launchGame,
  listInstalledRuntimes,
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
  validate,
  validatePlayerName,
  writeOptionsTxt
} from '@mcl/core'
import type {
  Account,
  AuthenticateResponse,
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
import { ComponentHost } from '@mcl/host'
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

  constructor(
    readonly rootDir: string,
    private readonly send: (channel: string, payload: unknown) => void
  ) {
    this.settingsPath = join(rootDir, 'settings.json')
    this.components = new ComponentHost((info) =>
      console.log(`[components] ${info.id} → ${info.state}${info.reason ? `（${info.reason}）` : ''}`)
    )
    this.components.setCoEffect('game.notRunning', true)
    this.components.setCoEffect('ai.configured', this.isAiConfigured())
    this.components.register(createAiToolsComponent(this.aiToolsDeps()))
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
      this.manifest = await fetchVersionManifest()
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

  /** 游戏实例目录（mods/options.txt/logs 都在这里）。 */
  private instanceDir(): string {
    return join(this.rootDir, 'instances', 'main')
  }

  /** 启动游戏（需已安装版本 + 已保存账户）。日志经事件推送并缓冲。 */
  async launchVersion(id: string): Promise<{ logFile: string }> {
    if (typeof id !== 'string') throw new Error('invalid version id')
    if (this.game) throw new Error('已有游戏在运行')
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
      gameDir: this.instanceDir(),
      rootDir: this.rootDir,
      launcherName: 'MCL',
      launcherVersion: '0.1.0',
      ...(javaAgent ? { javaAgent } : {}),
      clientJarPath: resolved.clientJarPath
    })

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

  listModsPayload(): Promise<ModFileInfo[]> {
    return listMods(this.instanceDir())
  }

  removeModFile(filename: string): Promise<void> {
    if (typeof filename !== 'string') throw new Error('invalid mod filename')
    return removeMod(this.instanceDir(), filename)
  }

  installModFromLocal(jarPath: string): Promise<string> {
    if (typeof jarPath !== 'string') throw new Error('invalid mod path')
    return installLocalMod(this.instanceDir(), jarPath)
  }

  readGameOptions(): Promise<Array<{ key: string; value: string }>> {
    return readOptionsTxt(this.instanceDir())
  }

  writeGameOptions(entries: Record<string, string>): Promise<Array<{ key: string; value: string }>> {
    if (typeof entries !== 'object' || entries === null) throw new Error('invalid options entries')
    return writeOptionsTxt(this.instanceDir(), entries)
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
      instanceDir: () => this.instanceDir(),
      launchVersion: (id) => this.launchVersion(id),
      installFabricVersion: (gameVersion, loaderVersion) => this.installFabricVersion(gameVersion, loaderVersion),
      listModsPayload: () => this.listModsPayload(),
      removeModFile: (filename) => this.removeModFile(filename),
      readGameOptions: () => this.readGameOptions(),
      writeGameOptions: (entries) => this.writeGameOptions(entries)
    }
  }

  private aiSystemPrompt(): string {
    return [
      '你是 Minecraft 第三方启动器 MCL 的内置助手。',
      '回答简洁、可操作；涉及版本与运行状态时优先调用工具查询而不是猜测。',
      '用户环境为 Windows；游戏实例目录在启动器数据目录的 instances/main 下。',
      '装 mod 流程：确认原版已安装 → install_fabric 装 Fabric 加载器 → search_mods（带 gameVersion+loader）→ install_mod（project/gameVersion/loader 必填）→ 建议用户启动对应的 fabric-loader 版本（launch_game）。',
      '改游戏设置用 read_config / write_config（options.txt，游戏下次启动生效）；启动游戏用 launch_game。',
      '对启动器或 mod 有不确定的版本兼容问题时，先向用户确认再操作。'
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
      }
      this.aiSession.addUser(text)

      const client = new ChatClient({ baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model })
      try {
        const result = await client.send(this.aiSession.messages(), this.components.getTools(), {
          onDelta: (t) => this.send('event:ai-delta', { text: t })
        })
        this.aiSession.addAssistant(result.content)
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
  }
}

/** 类型引用保留：JavaInfo 供未来 UI 显示探测详情。 */
export type { JavaInfo }
