import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { ComponentHost } from '@mcl/host'
import { isInstanceId } from '@mcl/host'
import { checkConsistency } from './consistency'
import { bundleSource, loadExtensionFromDir, parseManifest } from './loader'
import type { ExtensionLoadError, ExtensionManifest } from './loader'

/** 已安装扩展的渲染层摘要（不含 builtin.* 内建组件）。 */
export interface ExtensionSummary {
  id: string
  name: string
  version?: string
  capabilities: string[]
  fsInstances?: string[]
  netDomains?: string[]
  /** 宿主组件状态；disabled = 未装载（未注册到宿主）。 */
  state: 'active' | 'inactive' | 'disabled'
  /** 是否已装载（出现在宿主注册表中）。 */
  enabled: boolean
}

export interface ExtensionPipelineDeps {
  /** 用户扩展目录（extensions/<id>/）。 */
  extensionsDir: string
  /** 组件宿主（启用注册 / 停用注销；更新语义 = 先 unregister 再 register）。 */
  host: ComponentHost
  /** 宿主事件广播（launcher 传 IPC send）：event:ext-list-changed。 */
  notify(channel: string, payload: unknown): void
}

export interface SubmitResult {
  ok: true
  id: string
  message: string
}

export interface LoadInstalledResult {
  loaded: number
  disabled: number
  errors: ExtensionLoadError[]
}

/** 扩展目录内的停用标记：存在 = 不装载（默认生成后的状态）。 */
const DISABLED_MARKER = '.disabled'

const fileExists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

/**
 * AI 生成扩展流水线（C8）：生成即落盘；默认写 .disabled 不装载；
 * 用户可在插件页启用/停用，或由设置开启「生成后自动加载」。
 * launcher 只转发；本类是流水线全部业务逻辑（可单测，deps 注入）。
 */
export class ExtensionPipeline {
  /** 磁盘上已安装的扩展（含未加载的 disabled）；list() 的全集。 */
  private readonly installed = new Map<string, ExtensionManifest>()

  constructor(private readonly deps: ExtensionPipelineDeps) {}

  /**
   * 提交并保存扩展：结构校验（id 形态 + 保留占用）→ parseManifest（词汇表/协效应/作用域）
   * → 一致性检查（双向比对）→ 试打包（语法/内建 import 拒绝）→ 写盘。
   * 默认不装载（写 .disabled）；autoLoad=true 时立即热装载。
   * 校验失败的错误信息面向 AI 可读，AI 可修正后重新提交。
   */
  async submit(manifest: unknown, code: string, options: { autoLoad?: boolean } = {}): Promise<SubmitResult> {
    if (typeof manifest !== 'object' || manifest === null) throw new Error('manifest 需为对象')
    if (typeof code !== 'string' || code.trim() === '') throw new Error('扩展源码 code 不能为空')
    const raw = manifest as Record<string, unknown>
    const id = raw.id
    if (typeof id !== 'string' || !isInstanceId(id)) {
      throw new Error(`manifest.id 非法（${String(id)}）：需为 1-64 位字母/数字/._- 组成的目录名形态`)
    }
    if (id.startsWith('builtin.')) throw new Error('id 不能以 builtin. 开头（内建组件保留前缀）')
    if (id === 'sandbox.demo') throw new Error('id sandbox.demo 被内置示例扩展占用')
    const parsed = parseManifest(manifest, id)
    const consistency = checkConsistency(parsed, code)
    if (!consistency.ok) throw new Error(`一致性检查未通过：${consistency.summary}`)
    await bundleSource(code) // 试打包：语法错误 / node 内建 import 在此拒绝

    const dir = join(this.deps.extensionsDir, id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(parsed, null, 2))
    await fs.writeFile(join(dir, 'index.ts'), code)
    this.installed.set(id, parsed)

    // 更新语义：旧版本立即下装；新版本是否装载由 autoLoad 决定
    this.deps.host.unregister(id)
    try {
      if (options.autoLoad === true) {
        await this.loadAndRegister(id)
        await this.markEnabled(id)
      } else {
        await this.markDisabled(id)
      }
    } catch (err) {
      await this.markDisabled(id)
      this.deps.notify('event:ext-list-changed', this.list())
      throw err
    }
    this.deps.notify('event:ext-list-changed', this.list())

    return {
      ok: true,
      id,
      message:
        options.autoLoad === true
          ? `扩展 ${id} 已生成并自动加载`
          : `扩展 ${id} 已生成并保存（未加载，可在插件页启用）`
    }
  }

  /**
   * 扫描扩展目录并恢复安装状态（启动时调用）：
   * 有 .disabled 标记的只登记不装载；没有标记的恢复注册（兼容旧安装与 demo）。
   */
  async loadInstalled(): Promise<LoadInstalledResult> {
    this.installed.clear()
    const errors: ExtensionLoadError[] = []
    let loaded = 0
    let disabled = 0
    let entries
    try {
      entries = await fs.readdir(this.deps.extensionsDir, { withFileTypes: true })
    } catch {
      return { loaded, disabled, errors } // 目录不存在 = 无扩展
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(this.deps.extensionsDir, entry.name)
      if (!(await fileExists(join(dir, 'manifest.json')))) continue
      try {
        const manifest = await this.readManifest(dir)
        this.installed.set(manifest.id, manifest)
        if (await fileExists(join(dir, DISABLED_MARKER))) {
          disabled++
          continue
        }
        await this.loadAndRegister(manifest.id)
        loaded++
      } catch (err) {
        errors.push({ dir, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    return { loaded, disabled, errors }
  }

  /** 启用：从磁盘装载并注册，移除 .disabled 标记。 */
  async enable(id: string): Promise<SubmitResult> {
    this.assertInstalled(id)
    try {
      await this.loadAndRegister(id)
    } catch (err) {
      await this.markDisabled(id)
      this.deps.notify('event:ext-list-changed', this.list())
      throw err
    }
    await this.markEnabled(id)
    this.deps.notify('event:ext-list-changed', this.list())
    return { ok: true, id, message: `扩展 ${id} 已启用` }
  }

  /** 停用：注销宿主组件并写 .disabled 标记（重启后仍不装载）。 */
  async disable(id: string): Promise<SubmitResult> {
    this.assertInstalled(id)
    this.deps.host.unregister(id)
    await this.markDisabled(id)
    this.deps.notify('event:ext-list-changed', this.list())
    return { ok: true, id, message: `扩展 ${id} 已停用` }
  }

  /** 卸载扩展：host.unregister（宿主强制回滚面板/钩子/工具 + fs 补偿记录输出）→ 删除目录。 */
  async remove(id: string): Promise<SubmitResult> {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid extension id')
    if (!this.installed.has(id) || id.startsWith('builtin.')) throw new Error(`扩展 ${id} 未安装`)
    this.deps.host.unregister(id) // 注销即回滚；fs 补偿清单由 providers.revoke 输出
    await fs.rm(join(this.deps.extensionsDir, id), { recursive: true, force: true })
    this.installed.delete(id)
    this.deps.notify('event:ext-list-changed', this.list())
    return { ok: true, id, message: `扩展 ${id} 已卸载（其曾写入的文件见主进程补偿记录）` }
  }

  /** 已安装扩展清单（含 disabled；builtin.* 内建组件不进管理面）。 */
  list(): ExtensionSummary[] {
    const components = this.deps.host.listComponents().filter((c) => !c.id.startsWith('builtin.'))
    const byId = new Map(components.map((c) => [c.id, c]))
    const result: ExtensionSummary[] = []
    const seen = new Set<string>()
    for (const [id, manifest] of this.installed) {
      if (id.startsWith('builtin.')) continue
      const component = byId.get(id)
      seen.add(id)
      result.push({
        id,
        name: manifest.name,
        ...(manifest.version === undefined ? {} : { version: manifest.version }),
        capabilities: [...manifest.capabilities],
        ...(manifest.fsInstances ? { fsInstances: manifest.fsInstances } : {}),
        ...(manifest.netDomains ? { netDomains: manifest.netDomains } : {}),
        state: component?.state ?? 'disabled',
        enabled: component !== undefined
      })
    }
    // 兼容：宿主里存在但不在磁盘索引中的非内建组件（例如手工注册）仍可管理
    for (const c of components) {
      if (seen.has(c.id)) continue
      result.push({
        id: c.id,
        name: c.name,
        ...(c.manifest.version === undefined ? {} : { version: c.manifest.version }),
        capabilities: [...c.manifest.capabilities],
        ...(c.manifest.fsInstances ? { fsInstances: c.manifest.fsInstances } : {}),
        ...(c.manifest.netDomains ? { netDomains: c.manifest.netDomains } : {}),
        state: c.state,
        enabled: true
      })
    }
    return result
  }

  /** 从目录读取并校验 manifest（不打包，用于 disabled 扩展的清单展示）。 */
  private async readManifest(dir: string): Promise<ExtensionManifest> {
    const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf8').catch(() => {
      throw new Error('缺少 manifest.json')
    })
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      throw new Error(`manifest.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
    }
    return parseManifest(json, basename(dir))
  }

  private async loadAndRegister(id: string): Promise<void> {
    const { component } = await loadExtensionFromDir(join(this.deps.extensionsDir, id))
    this.deps.host.unregister(id) // 更新语义：先注销旧版再注册新版
    this.deps.host.register(component)
  }

  private assertInstalled(id: string): void {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid extension id')
    if (!this.installed.has(id)) throw new Error(`扩展 ${id} 未安装`)
  }

  private async markDisabled(id: string): Promise<void> {
    await fs.mkdir(join(this.deps.extensionsDir, id), { recursive: true })
    await fs.writeFile(join(this.deps.extensionsDir, id, DISABLED_MARKER), 'disabled\n')
  }

  private async markEnabled(id: string): Promise<void> {
    await fs.rm(join(this.deps.extensionsDir, id, DISABLED_MARKER), { force: true })
  }
}
