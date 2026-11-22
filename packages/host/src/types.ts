import type { AiTool } from '@mcl/agent'

/**
 * 能力词汇表（DESIGN.md §5.3 能力面）。ai.tools 为宿主内建授予；
 * 其余四项经 CapabilityProviders 注入（M5-4），未提供 provider 的能力在 register 即拒。
 */
export type CapabilityId = 'ai.tools' | 'ui.panel' | 'game.hooks' | 'fs.instance' | 'net.domains'

/** 能力词汇表的运行时清单（装载器校验与宿主 register 校验共用，单一事实源）。 */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  'ai.tools',
  'ui.panel',
  'game.hooks',
  'fs.instance',
  'net.domains'
]

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

/** 实例 id 合法性（目录名形态，禁路径分隔符与 ..）。 */
export function isInstanceId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(id) &&
    !id.includes('..')
  )
}

/** 主机名形态校验（域名白名单用：精确匹配、无通配、无协议/端口/路径）。 */
export function isHostname(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s)
  )
}

/** ai.tools 能力 API：注册 AiTool（M2 接口形状，MCP 兼容），返回注销函数。 */
export interface AiToolsApi {
  registerTool(tool: AiTool): () => void
}

// ---- ui.panel：声明式面板（扩展产 JSON schema，宿主渲染，不向沙箱暴露 React/DOM） ----

export type PanelItem =
  | { type: 'text'; content: string }
  | { type: 'kv'; rows: Record<string, string> }
  | { type: 'button'; label: string; action: string }

export interface PanelSchema {
  title: string
  items: PanelItem[]
}

/** 渲染层可见的面板状态（id = 组件 id，每组件一面板，重复 mount 即更新）。 */
export interface PanelState extends PanelSchema {
  id: string
}

export interface UiPanelApi {
  /** 挂载/更新本组件的面板；返回注销函数（撤板）。按钮点击时宿主回调 onAction。 */
  mountPanel(schema: PanelSchema, onAction: (action: string) => void | Promise<void>): () => void
}

// ---- game.hooks：启动前/后钩子 ----

export interface BeforeLaunchContext {
  versionId: string
  /** 已累积的附加 JVM 参数快照；本钩子的返回值按序追加，不修改此数组。 */
  jvmArgs: readonly string[]
}

export interface AfterExitContext {
  versionId: string
  /** 进程退出码；null = 信号终止。 */
  code: number | null
}

export interface GameHooksApi {
  /** 启动前钩子：返回 string[] 追加 JVM 参数；抛错 = 否决启动。返回注销函数。 */
  onBeforeLaunch(hook: (ctx: BeforeLaunchContext) => string[] | void | Promise<string[] | void>): () => void
  /** 进程退出后钩子；错误只记日志，不影响退出路径。返回注销函数。 */
  onAfterExit(hook: (ctx: AfterExitContext) => void | Promise<void>): () => void
}

// ---- fs.instance：限定实例目录的宿主代理 I/O ----

export interface FsInstanceApi {
  read(instanceId: string, relPath: string): Promise<string>
  write(instanceId: string, relPath: string, content: string): Promise<void>
  list(instanceId: string, relPath: string): Promise<string[]>
  remove(instanceId: string, relPath: string): Promise<void>
}

// ---- net.domains：白名单域名的宿主代理 HTTP ----

export interface NetRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface NetResponse {
  status: number
  body: string
}

export interface NetDomainsApi {
  httpRequest(url: string, options?: NetRequestOptions): Promise<NetResponse>
}

/** 组件清单：能力面与协效应的声明，宿主据此强制授权与重评估。 */
export interface ComponentManifest {
  /** 组件 id，全注册表唯一；内建组件用 builtin. 前缀。 */
  id: string
  name: string
  /** 扩展版本号（manifest.json 透传，供管理 UI 展示；内建组件无）。 */
  version?: string
  /** 声明请求的能力面；宿主只注入这里声明且已实现的能力（宿主强制而非组件自觉）。 */
  capabilities: CapabilityId[]
  /** 协效应依赖：任一不满足即被宿主停用。 */
  requires: CoEffectExpr[]
  /** fs.instance 作用域：允许读写的实例 id（声明 fs.instance 时必填）。 */
  fsInstances?: string[]
  /** net.domains 白名单主机名（声明 net.domains 时必填，精确匹配）。 */
  netDomains?: string[]
}

/** 能力授予：API + 宿主强制回滚（组件停用/卸载时 revoke 带原因，不依赖组件自觉）。 */
export interface CapabilityGrant<T> {
  api: T
  revoke(reason?: 'co-effect' | 'unregistered'): void
}

export type CapabilityProvider<T> = (componentId: string, manifest: ComponentManifest) => CapabilityGrant<T>

/** 非内建能力的实现入口（launcher 注入；未提供的能力在 register 即拒）。 */
export interface CapabilityProviders {
  'ui.panel'?: CapabilityProvider<UiPanelApi>
  'game.hooks'?: CapabilityProvider<GameHooksApi>
  'fs.instance'?: CapabilityProvider<FsInstanceApi>
  'net.domains'?: CapabilityProvider<NetDomainsApi>
}

/** 能力授予上下文：未声明/未实现的能力键不存在。 */
export interface ComponentContext {
  readonly componentId: string
  readonly capabilities: {
    'ai.tools'?: AiToolsApi
    'ui.panel'?: UiPanelApi
    'game.hooks'?: GameHooksApi
    'fs.instance'?: FsInstanceApi
    'net.domains'?: NetDomainsApi
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
