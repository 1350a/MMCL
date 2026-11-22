import { promises as fs } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { assertSafeRemoteUrl } from '@mcl/core'
import type {
  AfterExitContext,
  BeforeLaunchContext,
  CapabilityGrant,
  CapabilityProviders,
  ComponentManifest,
  PanelItem,
  PanelSchema,
  PanelState,
  UiPanelApi,
  GameHooksApi,
  FsInstanceApi,
  NetDomainsApi
} from '@mcl/host'
import { isInstanceId } from '@mcl/host'

export interface CapabilityDeps {
  /** 面板/补偿等宿主事件广播（launcher 传 IPC send；缺省 console 提示）。 */
  send?: (channel: string, payload: unknown) => void
  /** 实例 id → 实例目录（声明 fs.instance 能力的组件被授予时必需）。 */
  instanceDirFor?: (instanceId: string) => string
  /** HTTP 实现（测试注入 fake；缺省全局 fetch）。 */
  fetchImpl?: typeof fetch
  /** 退出钩子错误日志（缺省 console.error）。 */
  onHookError?: (componentId: string, err: unknown) => void
}

export interface CompensatedOp {
  componentId: string
  op: 'write' | 'remove'
  instanceId: string
  relPath: string
  at: string
}

export interface CapabilityRuntime {
  providers: CapabilityProviders
  /** 当前全部已挂载面板（渲染层拉取/推送）。 */
  getPanels(): PanelState[]
  /** 渲染层按钮点击 → 面板 onAction 回调。 */
  panelAction(panelId: string, action: string): Promise<void>
  /** 启动前钩子依序执行：抛错 = 否决启动；返回按序追加的 JVM 参数。 */
  runBeforeLaunch(ctx: { versionId: string; jvmArgs: readonly string[] }): Promise<string[]>
  /** 退出后钩子依序执行（容错：错误记日志不抛）。 */
  runAfterExit(ctx: { versionId: string; code: number | null }): Promise<void>
  /** 补偿记录（诊断用；卸载时由 revoke 输出）。 */
  getCompensation(): CompensatedOp[]
}

const NET_TIMEOUT_MS = 30_000
const NET_BODY_MAX = 1_000_000
const HOOK_ERROR_PREFIX = '[hooks]'

/**
 * 四项能力的通用宿主实现（M5-4）。launcher 只注入原语：
 * send（面板/补偿广播）、instanceDirFor（实例目录定位）、fetchImpl（测试）。
 * 面板/钩子按组件 id 记账；fs 写/删记补偿清单（设计：卸载即列出该扩展写过的文件）。
 */
export function createCapabilityProviders(deps: CapabilityDeps): CapabilityRuntime {
  const log = deps.onHookError ?? ((id, err) => console.error(`${HOOK_ERROR_PREFIX} ${id} 退出钩子失败：`, err))
  const broadcastPanels = (): void => {
    const panels = getPanels()
    if (deps.send) deps.send('event:panel-changed', panels)
    else console.log('[panels]', JSON.stringify(panels))
  }

  // ---- ui.panel ----
  const panels = new Map<string, { schema: PanelSchema; onAction: (action: string) => void | Promise<void> }>()
  const getPanels = (): PanelState[] =>
    [...panels.entries()].map(([id, p]) => ({ id, title: p.schema.title, items: p.schema.items }))
  const validatePanelSchema = (schema: unknown): PanelSchema => {
    if (typeof schema !== 'object' || schema === null) throw new Error('面板 schema 需为对象')
    const s = schema as Record<string, unknown>
    if (typeof s.title !== 'string' || s.title.length === 0) throw new Error('面板缺少有效 title')
    if (!Array.isArray(s.items)) throw new Error('面板 items 需为数组')
    const items = s.items.map((raw, i): PanelItem => {
      if (typeof raw !== 'object' || raw === null) throw new Error(`面板 items[${i}] 需为对象`)
      const it = raw as Record<string, unknown>
      if (it.type === 'text') {
        if (typeof it.content !== 'string') throw new Error(`面板 items[${i}] text 缺少 content`)
        return { type: 'text', content: it.content }
      }
      if (it.type === 'kv') {
        if (typeof it.rows !== 'object' || it.rows === null) throw new Error(`面板 items[${i}] kv 缺少 rows`)
        const rows: Record<string, string> = {}
        for (const [k, v] of Object.entries(it.rows as Record<string, unknown>)) {
          rows[String(k)] = String(v)
        }
        return { type: 'kv', rows }
      }
      if (it.type === 'button') {
        if (typeof it.label !== 'string' || typeof it.action !== 'string') {
          throw new Error(`面板 items[${i}] button 需要 label 与 action`)
        }
        return { type: 'button', label: it.label, action: it.action }
      }
      throw new Error(`面板 items[${i}] 未知元素类型 ${String(it.type)}（支持 text/kv/button）`)
    })
    return { title: s.title, items }
  }
  const uiPanelProvider = (componentId: string): CapabilityGrant<UiPanelApi> => ({
    api: {
      mountPanel: (schema, onAction) => {
        const valid = validatePanelSchema(schema)
        panels.set(componentId, { schema: valid, onAction })
        broadcastPanels()
        let done = false
        return () => {
          if (done) return
          done = true
          if (panels.get(componentId)?.schema === valid) {
            panels.delete(componentId)
            broadcastPanels()
          }
        }
      }
    },
    revoke: () => {
      if (panels.delete(componentId)) broadcastPanels()
    }
  })

  // ---- game.hooks ----
  const beforeLaunchHooks: Array<{ id: string; hook: (ctx: BeforeLaunchContext) => Promise<string[] | void> }> = []
  const afterExitHooks: Array<{ id: string; hook: (ctx: AfterExitContext) => Promise<void> }> = []
  const gameHooksProvider = (componentId: string): CapabilityGrant<GameHooksApi> => ({
    api: {
      onBeforeLaunch: (hook) => {
        const entry = { id: componentId, hook: async (ctx: BeforeLaunchContext) => await hook(ctx) }
        beforeLaunchHooks.push(entry)
        let done = false
        return () => {
          if (done) return
          done = true
          const i = beforeLaunchHooks.indexOf(entry)
          if (i >= 0) beforeLaunchHooks.splice(i, 1)
        }
      },
      onAfterExit: (hook) => {
        const entry = { id: componentId, hook: async (ctx: AfterExitContext) => await hook(ctx) }
        afterExitHooks.push(entry)
        let done = false
        return () => {
          if (done) return
          done = true
          const i = afterExitHooks.indexOf(entry)
          if (i >= 0) afterExitHooks.splice(i, 1)
        }
      }
    },
    revoke: () => {
      // 停用/卸载都移除钩子（宿主强制）；co-effect 恢复时会重新激活并重新注册
      for (let i = beforeLaunchHooks.length - 1; i >= 0; i--) {
        if (beforeLaunchHooks[i].id === componentId) beforeLaunchHooks.splice(i, 1)
      }
      for (let i = afterExitHooks.length - 1; i >= 0; i--) {
        if (afterExitHooks[i].id === componentId) afterExitHooks.splice(i, 1)
      }
    }
  })

  // ---- fs.instance ----
  const compensation: CompensatedOp[] = []
  const record = (op: Omit<CompensatedOp, 'at'>): void => {
    compensation.push({ ...op, at: new Date().toISOString() })
  }
  const resolveInInstance = (instanceId: string, relPath: string): string => {
    if (!isInstanceId(instanceId)) throw new Error(`非法实例 id ${String(instanceId)}`)
    if (!deps.instanceDirFor) throw new Error('宿主未提供 instanceDirFor，fs.instance 不可用')
    const base = deps.instanceDirFor(instanceId)
    const target = resolve(base, relPath)
    if (target !== base && !target.startsWith(base + sep)) throw new Error(`路径越界：${relPath}`)
    return target
  }
  const assertAllowed = (manifest: ComponentManifest, instanceId: string): void => {
    if (!(manifest.fsInstances ?? []).includes(instanceId)) {
      throw new Error(`实例 ${instanceId} 不在本扩展的 fs.instance 作用域（${(manifest.fsInstances ?? []).join('、') || '无'}）`)
    }
  }
  const fsProvider = (componentId: string, manifest: ComponentManifest): CapabilityGrant<FsInstanceApi> => ({
    api: {
      read: async (instanceId, relPath) => {
        assertAllowed(manifest, instanceId)
        return fs.readFile(resolveInInstance(instanceId, relPath), 'utf8')
      },
      write: async (instanceId, relPath, content) => {
        assertAllowed(manifest, instanceId)
        const target = resolveInInstance(instanceId, relPath)
        await fs.mkdir(dirname(target), { recursive: true })
        await fs.writeFile(target, content, 'utf8')
        record({ componentId, op: 'write', instanceId, relPath })
      },
      list: async (instanceId, relPath) => {
        assertAllowed(manifest, instanceId)
        const entries = await fs.readdir(resolveInInstance(instanceId, relPath), { withFileTypes: true })
        return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name))
      },
      remove: async (instanceId, relPath) => {
        assertAllowed(manifest, instanceId)
        await fs.rm(resolveInInstance(instanceId, relPath), { force: false })
        record({ componentId, op: 'remove', instanceId, relPath })
      }
    },
    revoke: (reason?: 'co-effect' | 'unregistered') => {
      // 补偿清单在「卸载」时列出（co-effect 停用是暂态，恢复激活后组件继续工作）
      if (reason === 'unregistered') {
        const ops = compensation.filter((c) => c.componentId === componentId)
        if (ops.length > 0) {
          console.log(
            `[extensions] 补偿记录（${componentId} 曾写入/删除以下文件，卸载不做物理回滚）：`,
            JSON.stringify(ops)
          )
        }
      }
    }
  })

  // ---- net.domains ----
  const netProvider = (componentId: string, manifest: ComponentManifest): CapabilityGrant<NetDomainsApi> => ({
    api: {
      httpRequest: async (url, options) => {
        const domains = manifest.netDomains ?? []
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new Error(`非法 URL：${url}`)
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`仅支持 http/https（收到 ${parsed.protocol}）`)
        }
        const host = parsed.hostname.toLowerCase()
        if (!domains.some((d) => d.toLowerCase() === host)) {
          throw new Error(`域名 ${host} 不在白名单（${domains.join('、')}）`)
        }
        // 白名单域名不豁免 SSRF 校验：解析目标仍可能是私网/环回
        assertSafeRemoteUrl(url)
        const method = (options?.method ?? 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'POST') throw new Error(`暂只支持 GET/POST（收到 ${method}）`)
        const fetchImpl = deps.fetchImpl ?? fetch
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), NET_TIMEOUT_MS)
        try {
          const res = await fetchImpl(url, {
            method,
            headers: options?.headers,
            body: options?.body,
            signal: ac.signal
          })
          const text = await res.text()
          return { status: res.status, body: text.length > NET_BODY_MAX ? text.slice(0, NET_BODY_MAX) : text }
        } finally {
          clearTimeout(timer)
        }
      }
    },
    revoke: () => undefined
  })

  const providers: CapabilityProviders = {
    'ui.panel': uiPanelProvider,
    'game.hooks': gameHooksProvider,
    'fs.instance': fsProvider,
    'net.domains': netProvider
  }

  return {
    providers,
    getPanels,
    panelAction: async (panelId, action) => {
      const p = panels.get(panelId)
      if (!p) throw new Error(`面板 ${panelId} 不存在`)
      await p.onAction(action)
    },
    runBeforeLaunch: async (ctx) => {
      const extra: string[] = []
      for (const entry of beforeLaunchHooks) {
        const out = await entry.hook({ versionId: ctx.versionId, jvmArgs: [...extra] })
        if (Array.isArray(out)) extra.push(...out.map(String))
      }
      return extra
    },
    runAfterExit: async (ctx) => {
      for (const entry of afterExitHooks) {
        try {
          await entry.hook(ctx)
        } catch (err) {
          log(entry.id, err)
        }
      }
    },
    getCompensation: () => [...compensation]
  }
}
