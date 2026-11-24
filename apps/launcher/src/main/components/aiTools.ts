import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { installModFile, listModVersions, searchMods } from '@mcl/core'
import type { InstanceMeta, ModFileInfo, RuntimeInfo } from '@mcl/core'
import type { AiTool } from '@mcl/agent'
import type { HostComponent } from '@mcl/host'
import type { SubmitResult } from '@mcl/ext-runtime'

/** 内建 AI 工具组件对启动器状态的依赖（由 LauncherService 适配注入）。 */
export interface AiToolsDeps {
  listInstalledVersions(): Promise<string[]>
  listRuntimes(): Promise<RuntimeInfo[]>
  /** 当前配置的 javaPath（未配置为空串）。 */
  javaPath(): string
  isGameRunning(): boolean
  /** 实例目录定位（mods/options.txt/logs 都在实例目录下）。 */
  instanceDirFor(instanceId: string): string
  /** 实例清单（M6 多实例）。 */
  listInstancesPayload(): Promise<InstanceMeta[]>
  /** 新建实例（id 缺省自动生成；versionId 可绑定）。 */
  createInstancePayload(input: { id?: string; name: string; versionId?: string }): Promise<InstanceMeta>
  /** 启动实例绑定的版本。 */
  launchInstance(instanceId: string): Promise<{ logFile: string }>
  installFabricVersion(gameVersion: string, loaderVersion?: string): Promise<{ versionId: string }>
  listModsPayload(instanceId: string): Promise<ModFileInfo[]>
  removeModFile(instanceId: string, filename: string): Promise<void>
  readGameOptions(instanceId: string): Promise<Array<{ key: string; value: string }>>
  writeGameOptions(instanceId: string, entries: Record<string, string>): Promise<Array<{ key: string; value: string }>>
  /** 提交扩展（C8：一致性检查 → 保存；默认不装载，用户手动启用）。 */
  submitExtensionProposal(manifest: unknown, code: string): Promise<SubmitResult>
}

/** 工具 args 的 instanceId 归一：缺省 main。 */
const resolveInstanceId = (args: Record<string, unknown>): string =>
  typeof args.instanceId === 'string' && args.instanceId !== '' ? args.instanceId : 'main'

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
      description: '读取实例的游戏日志（logs/latest.log）尾部与 crash-reports 最新崩溃报告。instanceId 缺省 main。',
      parameters: {
        type: 'object',
        properties: { instanceId: { type: 'string', description: '实例 id（见 list_instances），缺省 main' } }
      },
      handler: async (args) => {
        const instanceDir = deps.instanceDirFor(resolveInstanceId(args))
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
      name: 'list_instances',
      description: '列出游戏实例（多实例：每个实例是独立的 mods/存档/设置目录，绑定一个已安装版本）。',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const instances = await deps.listInstancesPayload()
        return JSON.stringify({
          instances: instances.map((i) => ({ id: i.id, name: i.name, versionId: i.versionId ?? null }))
        })
      }
    },
    {
      name: 'create_instance',
      description:
        '新建游戏实例（独立 mods/存档/设置）。name 必填；versionId 建议绑定已安装版本（可用 list_versions 查）；id 缺省自动生成。新实例不会影响 main 实例的 mods 与存档。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '实例显示名（1-64 字符）' },
          versionId: { type: 'string', description: '绑定的已安装版本 id，如 1.16.5' },
          id: { type: 'string', description: '实例 id（目录名形态：字母/数字/._-），缺省自动生成' }
        },
        required: ['name']
      },
      handler: async (args) => {
        if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('name 需为非空字符串')
        const input: { id?: string; name: string; versionId?: string } = { name: args.name }
        if (typeof args.id === 'string' && args.id !== '') input.id = args.id
        if (typeof args.versionId === 'string' && args.versionId !== '') input.versionId = args.versionId
        const meta = await deps.createInstancePayload(input)
        return JSON.stringify({ ok: true, instance: { id: meta.id, name: meta.name, versionId: meta.versionId ?? null } })
      }
    },
    {
      name: 'launch_game',
      description:
        '启动一个实例（实例绑定版本的启动）。instanceId 缺省时只有一个实例就自动选它；实例未绑定版本会报错提示；游戏已在运行时会失败。',
      parameters: {
        type: 'object',
        properties: { instanceId: { type: 'string', description: '实例 id（见 list_instances）' } }
      },
      handler: async (args) => {
        let instanceId = typeof args.instanceId === 'string' && args.instanceId ? args.instanceId : ''
        if (!instanceId) {
          const instances = await deps.listInstancesPayload()
          if (instances.length === 1) instanceId = instances[0].id
          else {
            return JSON.stringify({
              error: `需要指定 instanceId。现有实例：${instances.map((i) => i.id).join('、') || '（无）'}`
            })
          }
        }
        const { logFile } = await deps.launchInstance(instanceId)
        return JSON.stringify({ ok: true, instanceId, logFile })
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
        '从 Modrinth 下载一个 mod 到实例 mods 目录（取该版本 primary 文件，sha1 校验）。project 为项目 id 或 slug；version 可传 version_number 或版本 id，缺省取过滤后最新一个。gameVersion 与 loader 必填以防装错版本。instanceId 缺省 main。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Modrinth 项目 id 或 slug' },
          version: { type: 'string', description: 'version_number 或版本 id，缺省最新' },
          gameVersion: { type: 'string', description: '目标游戏版本，如 1.16.5' },
          loader: { type: 'string', description: '目标加载器，如 fabric' },
          instanceId: { type: 'string', description: '实例 id（见 list_instances），缺省 main' }
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
        const dest = await installModFile(deps.instanceDirFor(resolveInstanceId(args)), file)
        return JSON.stringify({ ok: true, mod: chosen.versionNumber, filename: file.filename, dest })
      }
    },
    {
      name: 'list_mods',
      description: '列出实例 mods 目录已装的 mod 文件。instanceId 缺省 main。',
      parameters: {
        type: 'object',
        properties: { instanceId: { type: 'string', description: '实例 id（见 list_instances），缺省 main' } }
      },
      handler: async (args) => JSON.stringify({ mods: await deps.listModsPayload(resolveInstanceId(args)) })
    },
    {
      name: 'remove_mod',
      description: '从实例 mods 目录删除一个 mod（按文件名）。instanceId 缺省 main。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'mods 目录下的文件名' },
          instanceId: { type: 'string', description: '实例 id（见 list_instances），缺省 main' }
        },
        required: ['filename']
      },
      handler: async (args) => {
        if (typeof args.filename !== 'string') throw new Error('filename 需为字符串')
        await deps.removeModFile(resolveInstanceId(args), args.filename)
        return JSON.stringify({ ok: true })
      }
    },
    {
      name: 'read_config',
      description: '读取实例的游戏设置 options.txt（keys 缺省读全部）。instanceId 缺省 main。',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: '要读取的键，缺省全部' },
          instanceId: { type: 'string', description: '实例 id（见 list_instances），缺省 main' }
        }
      },
      handler: async (args) => {
        const all = await deps.readGameOptions(resolveInstanceId(args))
        const keys = Array.isArray(args.keys)
          ? args.keys.filter((k): k is string => typeof k === 'string')
          : null
        return JSON.stringify({ options: keys ? all.filter((e) => keys.includes(e.key)) : all })
      }
    },
    {
      name: 'write_config',
      description:
        '写入实例的游戏设置 options.txt（如 fov、gamma、musicVolume 等，值一律为字符串；游戏下次启动生效）。instanceId 缺省 main。',
      parameters: {
        type: 'object',
        properties: {
          entries: { type: 'object', additionalProperties: { type: 'string' } },
          instanceId: { type: 'string', description: '实例 id（见 list_instances），缺省 main' }
        },
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
        const options = await deps.writeGameOptions(resolveInstanceId(args), entries)
        return JSON.stringify({ ok: true, options })
      }
    },
    {
      name: 'generate_extension',
      description:
        '提交并保存一个启动器扩展（manifest + TypeScript 源码）。经静态一致性检查后写入扩展目录；默认不装载，用户需在插件页手动启用（设置开启自动加载时立即生效）。校验失败时错误信息会返回，修正后可重新提交。产出规范见系统提示的「扩展开发指南」。',
      parameters: {
        type: 'object',
        properties: {
          manifest: { type: 'object', description: '扩展 manifest 对象（id/name/version/capabilities 等）' },
          code: { type: 'string', description: '扩展 TypeScript 源码（export function activate(ctx)）' }
        },
        required: ['manifest', 'code']
      },
      handler: async (args) => {
        if (typeof args.manifest !== 'object' || args.manifest === null) throw new Error('manifest 需为对象')
        if (typeof args.code !== 'string' || args.code.trim() === '') throw new Error('code 需为非空字符串')
        const result = await deps.submitExtensionProposal(args.manifest, args.code)
        return JSON.stringify(result)
      }
    }
  ]
}
