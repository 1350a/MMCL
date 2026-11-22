import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ComponentHost } from '@mcl/host'
import { isInstanceId } from '@mcl/host'
import { checkConsistency } from './consistency'
import { bundleSource, loadExtensionFromDir, parseManifest } from './loader'
import type { ExtensionManifest } from './loader'

/** 待审核提案（单槽 MVP：占用即拒）。 */
export interface PendingExtension {
  manifest: ExtensionManifest
  /** 未打包的扩展源码（审核卡全文展示）。 */
  code: string
}

/** 已注册扩展的渲染层摘要（不含 builtin.* 内建组件）。 */
export interface ExtensionSummary {
  id: string
  name: string
  version?: string
  capabilities: string[]
  fsInstances?: string[]
  netDomains?: string[]
  state: 'active' | 'inactive'
}

export interface ExtensionPipelineDeps {
  /** 用户扩展目录（approve 落盘 extensions/<id>/，remove 按目录删除）。 */
  extensionsDir: string
  /** 组件宿主（approve 注册 / remove 注销，更新语义 = 先 unregister 再 register）。 */
  host: ComponentHost
  /** 宿主事件广播（launcher 传 IPC send）：event:ext-pending / event:ext-list-changed。 */
  notify(channel: string, payload: unknown): void
}

export interface SubmitResult {
  ok: true
  id: string
  message: string
}

/**
 * AI 生成扩展流水线（M5-5）：提交 → 静态一致性检查 → 人工审核 → 热装载 → 卸载零残留。
 * launcher 只转发；本类是流水线全部业务逻辑（可单测，deps 注入）。
 */
export class ExtensionPipeline {
  private pending: PendingExtension | null = null

  constructor(private readonly deps: ExtensionPipelineDeps) {}

  /**
   * 提交扩展提案：结构校验（id 形态 + 保留占用）→ parseManifest（词汇表/协效应/作用域）
   * → 一致性检查（双向比对）→ 试打包（语法/内建 import 拒绝）→ 入待审槽并通知。
   * 校验失败的错误信息面向 AI 可读，AI 可修正后重新提交。
   */
  async submit(manifest: unknown, code: string): Promise<SubmitResult> {
    if (typeof manifest !== 'object' || manifest === null) throw new Error('manifest 需为对象')
    if (typeof code !== 'string' || code.trim() === '') throw new Error('扩展源码 code 不能为空')
    const raw = manifest as Record<string, unknown>
    const id = raw.id
    if (typeof id !== 'string' || !isInstanceId(id)) {
      throw new Error(`manifest.id 非法（${String(id)}）：需为 1-64 位字母/数字/._- 组成的目录名形态`)
    }
    if (id.startsWith('builtin.')) throw new Error(`id 不能以 builtin. 开头（内建组件保留前缀）`)
    if (id === 'sandbox.demo') throw new Error('id sandbox.demo 被内置示例扩展占用')
    const parsed = parseManifest(manifest, id)
    const consistency = checkConsistency(parsed, code)
    if (!consistency.ok) throw new Error(`一致性检查未通过：${consistency.summary}`)
    await bundleSource(code) // 试打包：语法错误 / node 内建 import 在此拒绝
    if (this.pending) {
      throw new Error(`已有待审核的扩展提案（${this.pending.manifest.id}），请先批准或拒绝后再提交`)
    }
    this.pending = { manifest: parsed, code }
    this.deps.notify('event:ext-pending', this.pending)
    return { ok: true, id, message: `提案 ${id} 已提交，等待用户在扩展审核卡中批准` }
  }

  /** 批准并热装载：落盘 extensions/<id>/ → 装载 → 同 id 已注册先注销（更新语义）→ 注册。 */
  async approve(): Promise<SubmitResult> {
    const pending = this.pending
    if (!pending) throw new Error('没有待审核的扩展提案')
    const { manifest, code } = pending
    const dir = join(this.deps.extensionsDir, manifest.id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await fs.writeFile(join(dir, 'index.ts'), code)
    const { component } = await loadExtensionFromDir(dir)
    if (this.deps.host.listComponents().some((c) => c.id === manifest.id)) {
      this.deps.host.unregister(manifest.id)
    }
    this.deps.host.register(component)
    this.pending = null
    this.deps.notify('event:ext-pending', null)
    this.deps.notify('event:ext-list-changed', this.list())
    return { ok: true, id: manifest.id, message: `扩展 ${manifest.id} 已批准并装载` }
  }

  /** 拒绝提案：清槽即可（未落盘未注册，天然零残留）。 */
  reject(): SubmitResult {
    const pending = this.pending
    if (!pending) throw new Error('没有待审核的扩展提案')
    this.pending = null
    this.deps.notify('event:ext-pending', null)
    return { ok: true, id: pending.manifest.id, message: `提案 ${pending.manifest.id} 已拒绝` }
  }

  /** 卸载扩展：host.unregister（宿主强制回滚面板/钩子/工具 + fs 补偿记录输出）→ 删除目录。 */
  async remove(id: string): Promise<SubmitResult> {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid extension id')
    if (!this.list().some((e) => e.id === id)) throw new Error(`扩展 ${id} 未注册`)
    this.deps.host.unregister(id) // 注销即回滚；fs 补偿清单由 providers.revoke 输出
    await fs.rm(join(this.deps.extensionsDir, id), { recursive: true, force: true })
    this.deps.notify('event:ext-list-changed', this.list())
    return { ok: true, id, message: `扩展 ${id} 已卸载（其曾写入的文件见主进程补偿记录）` }
  }

  /** 已注册扩展清单（builtin.* 内建组件不进管理 UI）。 */
  list(): ExtensionSummary[] {
    return this.deps.host
      .listComponents()
      .filter((c) => !c.id.startsWith('builtin.'))
      .map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.manifest.version === undefined ? {} : { version: c.manifest.version }),
        capabilities: [...c.manifest.capabilities],
        ...(c.manifest.fsInstances ? { fsInstances: c.manifest.fsInstances } : {}),
        ...(c.manifest.netDomains ? { netDomains: c.manifest.netDomains } : {}),
        state: c.state
      }))
  }

  /** 当前待审核提案（渲染层初始拉取与事件推送共用）。 */
  getPending(): PendingExtension | null {
    return this.pending
  }
}
