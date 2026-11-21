import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  assembleLaunch,
  assertJavaCompatible,
  detectJava,
  fetchVersionJson,
  fetchVersionManifest,
  findVersionEntry,
  installRuntime,
  installVersion,
  JavaVersionMismatchError,
  launchGame,
  listInstalledRuntimes,
  loadAccounts,
  mergeVersionJson,
  pickRuntime,
  saveAccounts,
  validatePlayerName
} from '@mcl/core'
import { ChatClient, ChatSession } from '@mcl/agent'
import type { AiTool } from '@mcl/agent'
import type { Account, RuntimeInfo, JavaInfo, VersionJson, VersionManifest } from '@mcl/core'

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

interface SettingsFile {
  javaPath?: string
  ai?: AiSettings
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

  constructor(
    readonly rootDir: string,
    private readonly send: (channel: string, payload: unknown) => void
  ) {
    this.settingsPath = join(rootDir, 'settings.json')
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

  /** 保存（单玩家 MVP：覆盖式单账户）。 */
  async saveAccount(name: string): Promise<Account> {
    if (typeof name !== 'string') throw new Error('invalid account name')
    validatePlayerName(name)
    await saveAccounts(this.rootDir, [{ name, uuid: '' }])
    return { name, uuid: '' }
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

  /** 安装一个版本（并发锁：同一时间一个安装任务），进度经事件推送。 */
  async installVersion(id: string): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid version id')
    if (this.installing) throw new Error('已有安装任务在进行中')
    this.installing = true
    try {
      const versionJson = await this.resolveVersionJson(id)
      await installVersion(versionJson, this.rootDir, {
        onProgress: (p) => this.send('event:install-progress', p)
      })
      this.send('event:install-done', { id, ok: true })
    } catch (err) {
      this.send('event:install-done', { id, ok: false, error: (err as Error).message })
      throw err
    } finally {
      this.installing = false
    }
  }

  private async loadInstalledVersionJson(id: string): Promise<VersionJson> {
    const raw = readFileSync(join(this.rootDir, 'versions', id, `${id}.json`), 'utf8')
    return JSON.parse(raw) as VersionJson
  }

  /** 启动游戏（需已安装版本 + 已保存账户）。日志经事件推送并缓冲。 */
  async launchVersion(id: string): Promise<{ logFile: string }> {
    if (typeof id !== 'string') throw new Error('invalid version id')
    if (this.game) throw new Error('已有游戏在运行')
    const account = await this.getAccount()
    if (!account) throw new Error('请先创建离线账户')
    const versionJson = await this.loadInstalledVersionJson(id)

    const java = await this.resolveJava(versionJson)

    const instanceDir = join(this.rootDir, 'instances', 'main')
    const spec = assembleLaunch(versionJson, {
      javaPath: java.path,
      account,
      gameDir: instanceDir,
      rootDir: this.rootDir,
      launcherName: 'MCL',
      launcherVersion: '0.1.0'
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
        this.send('event:game-exit', { code })
      },
      onError: (err) => this.send('event:game-log', { line: `进程错误: ${err.message}`, source: 'stderr' })
    })
    this.game = { handle, versionId: id }
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

  /** 下载内置 Java 运行时（Temurin JRE，约 45MB），进度经事件推送。 */
  async installRuntimeFor(major: number): Promise<RuntimeInfo> {
    if (!Number.isInteger(major) || major < 8) throw new Error(`invalid java major: ${major}`)
    if (this.javaInstalling) throw new Error('已有运行时下载在进行中')
    this.javaInstalling = true
    try {
      const info = await installRuntime(this.rootDir, major, {
        onProgress: (p) => this.send('event:java-install-progress', p)
      })
      return info
    } finally {
      this.javaInstalling = false
    }
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
    // 配置变化后重置会话（system prompt 无关，但客户端参数已变）
    this.aiSession = null
    return this.getAiConfig()
  }

  /** 构造 M2 两个工具：list_versions / read_crash_log（handler 注入 launcher 数据）。 */
  private buildAiTools(): AiTool[] {
    return [
      {
        name: 'list_versions',
        description: '列出启动器中已安装的 Minecraft 版本与内置 Java 运行时，以及游戏是否正在运行。',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const [installed, runtimes] = await Promise.all([this.listInstalledVersions(), this.listRuntimes()])
          return JSON.stringify({
            installedVersions: installed,
            builtInRuntimes: runtimes.map((r) => r.major),
            javaPath: this.readSettings().javaPath || '(未配置，走系统检测)',
            gameRunning: this.isGameRunning()
          })
        }
      },
      {
        name: 'read_crash_log',
        description: '读取游戏日志（logs/latest.log）的尾部，以及 crash-reports 目录下最新崩溃报告的内容。',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          const instanceDir = join(this.rootDir, 'instances', 'main')
          const parts: string[] = []
          try {
            const log = await fs.readFile(join(instanceDir, 'logs', 'latest.log'), 'utf8')
            const lines = log.split('\n')
            parts.push(`=== logs/latest.log 尾部 ${Math.min(200, lines.length)} 行 ===\n${lines.slice(-200).join('\n')}`)
          } catch {
            parts.push('=== logs/latest.log 不存在（游戏尚未运行过） ===')
          }
          try {
            const crashDir = join(instanceDir, 'crash-reports')
            const reports = (await fs.readdir(crashDir)).filter((f) => f.endsWith('.txt')).sort()
            if (reports.length > 0) {
              const latest = reports.at(-1)!
              const text = await fs.readFile(join(crashDir, latest), 'utf8')
              parts.push(`=== crash-reports/${latest} 头部 120 行 ===\n${text.split('\n').slice(0, 120).join('\n')}`)
            }
          } catch {
            // 无 crash-reports 目录
          }
          return parts.join('\n\n') || '没有任何日志或崩溃报告。'
        }
      }
    ]
  }

  private aiSystemPrompt(): string {
    return [
      '你是 Minecraft 第三方启动器 MCL 的内置助手。',
      '回答简洁、可操作；涉及版本与运行状态时优先调用工具查询而不是猜测。',
      '用户环境为 Windows；游戏实例目录在启动器数据目录的 instances/main 下。'
    ].join('\n')
  }

  /** 发送一条用户消息：主进程跑完整 tool 循环，流式增量与最终回复经事件推送。 */
  async aiSend(text: string): Promise<{ content: string }> {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('empty message')
    const { ai } = this.readSettings()
    if (!ai?.baseUrl || !ai?.apiKey || !ai?.model) {
      throw new Error('请先在 AI 卡片配置 baseURL / apiKey / model')
    }
    if (!this.aiSession) {
      this.aiSession = new ChatSession(this.aiSystemPrompt())
    }
    this.aiSession.addUser(text)

    const client = new ChatClient({ baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model })
    const result = await client.send(this.aiSession.messages(), this.buildAiTools(), {
      onDelta: (t) => this.send('event:ai-delta', { text: t })
    })
    this.aiSession.addAssistant(result.content)
    return { content: result.content }
  }

  aiClear(): void {
    this.aiSession?.clear()
  }
}

/** 类型引用保留：JavaInfo 供未来 UI 显示探测详情。 */
export type { JavaInfo }
