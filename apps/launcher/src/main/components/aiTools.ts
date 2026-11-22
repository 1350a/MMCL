import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { installModFile, listModVersions, searchMods } from '@mcl/core'
import type { ModFileInfo, RuntimeInfo } from '@mcl/core'
import type { AiTool } from '@mcl/agent'
import type { HostComponent } from '@mcl/host'

/** 内建 AI 工具组件对启动器状态的依赖（由 LauncherService 适配注入）。 */
export interface AiToolsDeps {
  listInstalledVersions(): Promise<string[]>
  listRuntimes(): Promise<RuntimeInfo[]>
  /** 当前配置的 javaPath（未配置为空串）。 */
  javaPath(): string
  isGameRunning(): boolean
  /** 游戏实例目录（mods/options.txt/logs 都在这里）。 */
  instanceDir(): string
  launchVersion(id: string): Promise<{ logFile: string }>
  installFabricVersion(gameVersion: string, loaderVersion?: string): Promise<{ versionId: string }>
  listModsPayload(): Promise<ModFileInfo[]>
  removeModFile(filename: string): Promise<void>
  readGameOptions(): Promise<Array<{ key: string; value: string }>>
  writeGameOptions(entries: Record<string, string>): Promise<Array<{ key: string; value: string }>>
}

/**
 * 内建 AI 工具组件（M5-1 dogfooding 第一刀）：与未来的沙箱扩展走同一套
 * manifest 声明 + 宿主授予能力面，无 API 等级差。
 */
export function createAiToolsComponent(deps: AiToolsDeps): HostComponent {
  return {
    manifest: {
      id: 'builtin.ai-tools',
      name: '内建 AI 工具',
      capabilities: ['ai.tools'],
      requires: ['ai.configured']
    },
    activate: (ctx) => {
      const api = ctx.capabilities['ai.tools']
      if (!api) throw new Error('宿主未授予 ai.tools 能力')
      const disposers = buildTools(deps).map((tool) => api.registerTool(tool))
      return () => disposers.forEach((dispose) => dispose())
    }
  }
}

/** 工具定义（原 LauncherService.buildAiTools，逻辑不变，状态经 deps 注入）。 */
function buildTools(deps: AiToolsDeps): AiTool[] {
  return [
    {
      name: 'list_versions',
      description: '列出启动器中已安装的 Minecraft 版本与内置 Java 运行时，以及游戏是否正在运行。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const [installed, runtimes] = await Promise.all([deps.listInstalledVersions(), deps.listRuntimes()])
        return JSON.stringify({
          installedVersions: installed,
          builtInRuntimes: runtimes.map((r) => r.major),
          javaPath: deps.javaPath() || '(未配置，走系统检测)',
          gameRunning: deps.isGameRunning()
        })
      }
    },
    {
      name: 'read_crash_log',
      description: '读取游戏日志（logs/latest.log）的尾部，以及 crash-reports 目录下最新崩溃报告的内容。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const instanceDir = deps.instanceDir()
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
    },
    {
      name: 'launch_game',
      description:
        '启动一个已安装的版本（原版或 Fabric 版本）。versionId 缺省且只装了一个版本时自动选它；游戏已在运行时会失败。',
      parameters: {
        type: 'object',
        properties: { versionId: { type: 'string', description: '要启动的版本 id（见 list_versions）' } }
      },
      handler: async (args) => {
        let versionId = typeof args.versionId === 'string' && args.versionId ? args.versionId : ''
        if (!versionId) {
          const installed = await deps.listInstalledVersions()
          if (installed.length === 1) versionId = installed[0]
          else {
            return JSON.stringify({
              error: `需要指定 versionId。已安装：${installed.join('、') || '（无）'}`
            })
          }
        }
        const { logFile } = await deps.launchVersion(versionId)
        return JSON.stringify({ ok: true, versionId, logFile })
      }
    },
    {
      name: 'install_fabric',
      description:
        '为已安装的原版版本安装 Fabric 加载器（生成形如 fabric-loader-<loader>-<原版> 的新版本）。loaderVersion 缺省取最新稳定版。',
      parameters: {
        type: 'object',
        properties: {
          gameVersion: { type: 'string', description: '已安装的原版版本 id，如 1.16.5' },
          loaderVersion: { type: 'string', description: 'Fabric loader 版本，缺省最新稳定版' }
        },
        required: ['gameVersion']
      },
      handler: async (args) => {
        if (typeof args.gameVersion !== 'string') throw new Error('gameVersion 需为字符串')
        const result = await deps.installFabricVersion(
          args.gameVersion,
          typeof args.loaderVersion === 'string' ? args.loaderVersion : undefined
        )
        return JSON.stringify({ ok: true, ...result })
      }
    },
    {
      name: 'search_mods',
      description: '在 Modrinth 搜索 mod，返回候选（projectId/slug/title/description/author）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          gameVersion: { type: 'string', description: '按游戏版本过滤（推荐，与目标版本一致）' },
          loader: { type: 'string', description: '按加载器过滤，如 fabric' },
          limit: { type: 'number', description: '返回条数，默认 10' }
        },
        required: ['query']
      },
      handler: async (args) => {
        if (typeof args.query !== 'string') throw new Error('query 需为字符串')
        const hits = await searchMods(args.query, {
          gameVersion: typeof args.gameVersion === 'string' ? args.gameVersion : undefined,
          loader: typeof args.loader === 'string' ? args.loader : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 10
        })
        return JSON.stringify({ hits })
      }
    },
    {
      name: 'install_mod',
      description:
        '从 Modrinth 下载一个 mod 到实例 mods 目录（取该版本 primary 文件，sha1 校验）。project 为项目 id 或 slug；version 可传 version_number 或版本 id，缺省取过滤后最新一个。gameVersion 与 loader 必填以防装错版本。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Modrinth 项目 id 或 slug' },
          version: { type: 'string', description: 'version_number 或版本 id，缺省最新' },
          gameVersion: { type: 'string', description: '目标游戏版本，如 1.16.5' },
          loader: { type: 'string', description: '目标加载器，如 fabric' }
        },
        required: ['project', 'gameVersion', 'loader']
      },
      handler: async (args) => {
        const project = typeof args.project === 'string' ? args.project : ''
        const gameVersion = typeof args.gameVersion === 'string' ? args.gameVersion : undefined
        const loader = typeof args.loader === 'string' ? args.loader : undefined
        if (!project || !gameVersion || !loader) {
          throw new Error('install_mod 需要 project、gameVersion、loader 三个参数')
        }
        const want = typeof args.version === 'string' && args.version ? args.version : undefined
        const versions = await listModVersions(project, { gameVersion, loader })
        if (versions.length === 0) {
          return JSON.stringify({ error: `Modrinth 上没有 ${project} 的 ${gameVersion}/${loader} 版本` })
        }
        const chosen =
          (want ? versions.find((v) => v.versionNumber === want || v.id === want) : undefined) ?? versions[0]
        const file = chosen.files.find((f) => f.primary) ?? chosen.files[0]
        if (!file) {
          return JSON.stringify({ error: `版本 ${chosen.versionNumber} 没有可下载文件` })
        }
        const dest = await installModFile(deps.instanceDir(), file)
        return JSON.stringify({ ok: true, mod: chosen.versionNumber, filename: file.filename, dest })
      }
    },
    {
      name: 'list_mods',
      description: '列出实例 mods 目录已装的 mod 文件。',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify({ mods: await deps.listModsPayload() })
    },
    {
      name: 'remove_mod',
      description: '从实例 mods 目录删除一个 mod（按文件名）。',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string', description: 'mods 目录下的文件名' } },
        required: ['filename']
      },
      handler: async (args) => {
        if (typeof args.filename !== 'string') throw new Error('filename 需为字符串')
        await deps.removeModFile(args.filename)
        return JSON.stringify({ ok: true })
      }
    },
    {
      name: 'read_config',
      description: '读取游戏设置 options.txt（实例目录；keys 缺省读全部）。',
      parameters: {
        type: 'object',
        properties: { keys: { type: 'array', items: { type: 'string' }, description: '要读取的键，缺省全部' } }
      },
      handler: async (args) => {
        const all = await deps.readGameOptions()
        const keys = Array.isArray(args.keys)
          ? args.keys.filter((k): k is string => typeof k === 'string')
          : null
        return JSON.stringify({ options: keys ? all.filter((e) => keys.includes(e.key)) : all })
      }
    },
    {
      name: 'write_config',
      description:
        '写入游戏设置 options.txt（如 fov、gamma、musicVolume 等，值一律为字符串；游戏下次启动生效）。',
      parameters: {
        type: 'object',
        properties: { entries: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['entries']
      },
      handler: async (args) => {
        if (typeof args.entries !== 'object' || args.entries === null) {
          throw new Error('entries 需为 { 键: 值 } 对象')
        }
        const entries: Record<string, string> = {}
        for (const [k, v] of Object.entries(args.entries as Record<string, unknown>)) {
          entries[k] = String(v)
        }
        const options = await deps.writeGameOptions(entries)
        return JSON.stringify({ ok: true, options })
      }
    }
  ]
}
