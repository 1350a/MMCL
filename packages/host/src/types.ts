import type { AiTool } from '@mcl/agent'

/**
 * 能力词汇表（DESIGN.md §5.3 能力面）。M5-1 仅实现 ai.tools；
 * ui.panel / game.hooks / fs.instance+net.domains 随沙箱与面板里程碑逐项落地，
 * 落地前不进词汇表——声明了宿主无法授予的能力应被拒绝装载，而不是拿到空 API。
 */
export type CapabilityId = 'ai.tools'

/**
 * 协效应（依赖声明）词汇表（§5.3）。宿主维护其真值，状态变化时重评估组件：
 * 任一 requires 不满足即停用（回滚其效应）并通知，恢复满足即重新激活。
 */
export type CoEffectExpr = 'game.notRunning' | 'ai.configured' | `instance.exists:${string}`

/** 运行时校验协效应表达式（manifest 声明与 setCoEffect 入口共用）。 */
export function isCoEffectExpr(expr: unknown): expr is CoEffectExpr {
  if (expr === 'game.notRunning' || expr === 'ai.configured') return true
  if (typeof expr !== 'string') return false
  return expr.startsWith('instance.exists:') && expr.length > 'instance.exists:'.length
}

/** ai.tools 能力 API：注册 AiTool（M2 接口形状，MCP 兼容），返回注销函数。 */
export interface AiToolsApi {
  registerTool(tool: AiTool): () => void
}

/** 组件清单：能力面与协效应的声明，宿主据此强制授权与重评估。 */
export interface ComponentManifest {
  /** 组件 id，全注册表唯一；内建组件用 builtin. 前缀。 */
  id: string
  name: string
  /** 声明请求的能力面；宿主只注入这里声明且已实现的能力（宿主强制而非组件自觉）。 */
  capabilities: CapabilityId[]
  /** 协效应依赖：任一不满足即被宿主停用。 */
  requires: CoEffectExpr[]
}

/** 能力授予上下文：未声明/未实现的能力键不存在。 */
export interface ComponentContext {
  readonly componentId: string
  readonly capabilities: {
    'ai.tools'?: AiToolsApi
  }
}

/**
 * 组件 = manifest 声明 + activate 实现（Cordis：组件接入携带逆操作）。
 * activate 返回注销函数，作为注册类效应（工具/面板/钩子注册）的回滚；
 * 协效应停用与卸载时由宿主调用。
 */
export interface HostComponent {
  manifest: ComponentManifest
  activate(ctx: ComponentContext): (() => void) | void
}

export type ComponentState = 'active' | 'inactive'

export interface ComponentChangeInfo {
  id: string
  state: ComponentState
  /** 停用原因（激活通知不带）。 */
  reason?: 'co-effect' | 'unregistered'
}

export interface ComponentInfo {
  id: string
  name: string
  manifest: ComponentManifest
  state: ComponentState
}
