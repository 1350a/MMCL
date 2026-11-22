import type { AiTool } from '@mcl/agent'
import type {
  AiToolsApi,
  CapabilityId,
  CoEffectExpr,
  ComponentChangeInfo,
  ComponentContext,
  ComponentInfo,
  ComponentManifest,
  HostComponent
} from './types'
import { isCoEffectExpr } from './types'

/** 全部已实现能力的 id：词汇表之外的 manifest 直接拒绝注册。 */
const CAPABILITIES: readonly CapabilityId[] = ['ai.tools']

/** 注册表条目：组件 + 激活产物（回滚函数 / 已注册效应）。 */
interface Entry {
  component: HostComponent
  state: 'active' | 'inactive'
  /** activate 返回的回滚函数；停用/卸载时调用。 */
  disposer: (() => void) | null
  /** 该组件当前注册的 AI 工具（宿主记账，不依赖组件自觉注销）。 */
  tools: Map<string, AiTool>
}

/**
 * ComponentHost：组件生命周期宿主（DESIGN.md §5.3，Cordis 思想工程化）。
 * - manifest 声明能力面，宿主强制授予：上下文只含已声明且宿主已实现的能力 API；
 * - 协效应 requires 由宿主重评估：不满足即停用（回滚效应）并通知，恢复即重新激活；
 * - 卸载即回滚：activate 返回注销函数；即使组件回滚有遗漏，宿主也兜底清理其效应。
 */
export class ComponentHost {
  private readonly entries = new Map<string, Entry>()
  private readonly coEffects = new Map<string, boolean>()
  /** 工具名 → 组件 id 全局索引：跨组件重名注册在授权时即拒绝。 */
  private readonly toolOwners = new Map<string, string>()

  constructor(private readonly onChange?: (info: ComponentChangeInfo) => void) {}

  /** 注册组件：manifest 校验通过且依赖已满足时立即激活。 */
  register(component: HostComponent): void {
    const manifest = component.manifest
    if (!manifest || typeof manifest.id !== 'string' || manifest.id.length === 0) {
      throw new Error('组件 manifest 缺少有效 id')
    }
    if (this.entries.has(manifest.id)) throw new Error(`组件 ${manifest.id} 已注册`)
    for (const cap of manifest.capabilities ?? []) {
      if (!CAPABILITIES.includes(cap)) throw new Error(`组件 ${manifest.id} 声明了未知能力 ${String(cap)}`)
    }
    for (const expr of manifest.requires ?? []) {
      if (!isCoEffectExpr(expr)) throw new Error(`组件 ${manifest.id} 声明了未知协效应 ${String(expr)}`)
    }
    this.entries.set(manifest.id, { component, state: 'inactive', disposer: null, tools: new Map() })
    if (this.requirementsMet(manifest)) this.activate(manifest.id)
  }

  /** 卸载组件：停用（回滚效应）并移出注册表。未注册时静默返回。 */
  unregister(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.deactivate(id, 'unregistered')
    this.entries.delete(id)
  }

  /** 组件清单（id / 名称 / 状态），供诊断与未来审核 UI。 */
  listComponents(): ComponentInfo[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.component.manifest.id,
      name: entry.component.manifest.name,
      manifest: entry.component.manifest,
      state: entry.state
    }))
  }

  /** 宿主推送协效应真值：变化即重评估全部组件（激活 / 停用并通知）。 */
  setCoEffect(expr: CoEffectExpr, satisfied: boolean): void {
    if (!isCoEffectExpr(expr)) throw new Error(`未知协效应 ${String(expr)}`)
    // 未设置视同 false：与初始态一致的真值推送是 no-op
    if ((this.coEffects.get(expr) ?? false) === satisfied) return
    this.coEffects.set(expr, satisfied)
    for (const [id, entry] of this.entries) {
      const met = this.requirementsMet(entry.component.manifest)
      if (met && entry.state === 'inactive') this.activate(id)
      if (!met && entry.state === 'active') this.deactivate(id, 'co-effect')
    }
  }

  /** 当前协效应真值快照（诊断用）。 */
  getCoEffects(): Record<string, boolean> {
    return Object.fromEntries(this.coEffects)
  }

  /** 聚合所有激活组件注册的 AI 工具（按组件注册顺序）。 */
  getTools(): AiTool[] {
    const tools: AiTool[] = []
    for (const entry of this.entries.values()) {
      if (entry.state === 'active') tools.push(...entry.tools.values())
    }
    return tools
  }

  // ---- 内部：激活 / 停用 / 能力授予 ----

  private requirementsMet(manifest: ComponentManifest): boolean {
    return (manifest.requires ?? []).every((expr) => this.coEffects.get(expr) === true)
  }

  private activate(id: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.state === 'active') return
    // 先置 active：激活期间组件自己的效应登记（如 registerTool）即合法
    entry.state = 'active'
    try {
      const disposer = entry.component.activate(this.buildContext(id)) ?? null
      entry.disposer = disposer
    } catch (err) {
      // 激活中途失败：清掉半注册的效应、回到未激活，错误交调用方处置
      entry.state = 'inactive'
      this.clearEffects(id)
      throw err
    }
    this.notify({ id, state: 'active' })
  }

  private deactivate(id: string, reason: 'co-effect' | 'unregistered'): void {
    const entry = this.entries.get(id)
    if (!entry || entry.state === 'inactive') return
    entry.state = 'inactive'
    try {
      entry.disposer?.()
    } finally {
      // 宿主强制清理：即使组件回滚函数有遗漏，其效应也不残留
      this.clearEffects(id)
    }
    this.notify({ id, state: 'inactive', reason })
  }

  private clearEffects(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.tools.clear()
    for (const [name, owner] of this.toolOwners) {
      if (owner === id) this.toolOwners.delete(name)
    }
    entry.disposer = null
  }

  /** 按 manifest 构建能力上下文：只注入声明且宿主已实现的能力。 */
  private buildContext(id: string): ComponentContext {
    const manifest = this.entries.get(id)!.component.manifest
    const capabilities: ComponentContext['capabilities'] = {}
    if (manifest.capabilities.includes('ai.tools')) {
      capabilities['ai.tools'] = this.grantAiTools(id)
    }
    return { componentId: id, capabilities }
  }

  private grantAiTools(id: string): AiToolsApi {
    return {
      registerTool: (tool: AiTool) => {
        const entry = this.entries.get(id)
        if (!entry || entry.state !== 'active') throw new Error(`组件 ${id} 未激活，无法注册工具`)
        if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
          throw new Error('工具缺少有效 name')
        }
        const owner = this.toolOwners.get(tool.name)
        if (owner && owner !== id) throw new Error(`工具 ${tool.name} 已被组件 ${owner} 注册`)
        entry.tools.set(tool.name, tool)
        this.toolOwners.set(tool.name, id)
        let done = false
        return () => {
          if (done) return
          done = true
          if (entry.tools.get(tool.name) === tool) entry.tools.delete(tool.name)
          if (this.toolOwners.get(tool.name) === id) this.toolOwners.delete(tool.name)
        }
      }
    }
  }

  private notify(info: ComponentChangeInfo): void {
    this.onChange?.(info)
  }
}
