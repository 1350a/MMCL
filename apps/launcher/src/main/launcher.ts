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
  installVersion,
  launchGame,
  loadAccounts,
  mergeVersionJson,
  saveAccounts,
  validatePlayerName
} from '@mcl/core'
import type { Account, JavaInfo, VersionJson, VersionManifest } from '@mcl/core'

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

interface SettingsFile {
  javaPath?: string
}

/** 启动器运行时状态与编排：IPC 路由层只调用这里的方法。 */
export class LauncherService {
  private readonly settingsPath: string
  private manifest: VersionManifest | null = null
  private installing = false
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

    const { javaPath } = this.readSettings()
    const java = await detectJava(javaPath || undefined)
    assertJavaCompatible(java, versionJson)

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

  stopGame(): void {
    this.game?.handle.process.kill()
  }

  readGameLog(): string {
    return this.logBuffer.join('\n')
  }

  isGameRunning(): boolean {
    return this.game !== null
  }
}

/** 类型引用保留：JavaInfo 供未来 UI 显示探测详情。 */
export type { JavaInfo }
