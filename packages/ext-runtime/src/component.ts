import type { AiTool } from '@mcl/agent'
import type { CoEffectExpr, HostComponent, PanelSchema } from '@mcl/host'
import { createSandbox } from './sandbox'
import type { SandboxCapability, SandboxHostApis } from './sandbox'

export interface SandboxComponentOptions {
  /** 组件 id（内建沙箱组件建议 sandbox. 前缀）。 */
  id: string
  name: string
  /** 扩展版本号（manifest.json 透传，供管理 UI 展示）。 */
  version?: string
  /** 扩展 bundle JS（约定 globalThis.__MCL_ENTRY__ = { activate(ctx) }）。 */
  code: string
  /** 声明的能力面（缺省 ['ai.tools']；须 ⊆ 宿主词汇表且宿主可授予）。 */
  capabilities?: SandboxCapability[]
  /** 协效应依赖（缺省 []）。 */
  requires?: CoEffectExpr[]
  /** fs.instance 作用域（声明 fs.instance 时必填）。 */
  fsInstances?: string[]
  /** net.domains 白名单（声明 net.domains 时必填）。 */
  netDomains?: string[]
  /** 单次执行的墙上时间片（毫秒），缺省用沙箱默认值。 */
  execTimeoutMs?: number
  /** 内存限制字节（单次分配语义），缺省用沙箱默认值。 */
  memoryLimitBytes?: number
}

/**
 * 把沙箱扩展包装为 HostComponent：activate 异步起沙箱跑扩展 activate（M5-4 起
 * activate 可 await 宿主 API，故沙箱初始化为 fire-and-forget——组件即刻 active，
 * 工具/面板就绪稍后），沙箱注册的工具经宿主能力面（ai.tools）转为 AiTool。
 * 卸载链：组件注销 → 本组件 disposer（取消未完成的初始化 + dispose 沙箱）→
 * ComponentHost 兜底 revoke（双保险）。
 */
export function createSandboxComponent(options: SandboxComponentOptions): HostComponent {
  const capabilities = options.capabilities ?? ['ai.tools']
  return {
    manifest: {
      id: options.id,
      name: options.name,
      ...(options.version === undefined ? {} : { version: options.version }),
      capabilities,
      requires: options.requires ?? [],
      ...(options.fsInstances ? { fsInstances: options.fsInstances } : {}),
      ...(options.netDomains ? { netDomains: options.netDomains } : {})
    },
    activate: (ctx) => {
      // 宿主能力 API（按声明取；宿主已保证授予）
      const apis = ctx.capabilities
      const hostApis: SandboxHostApis = {}
      if (capabilities.includes('ui.panel')) {
        const ui = apis['ui.panel']
        if (!ui) throw new Error(`宿主未授予 ${options.id} ui.panel 能力`)
        hostApis.mountPanel = (schema: PanelSchema, onAction) => ui.mountPanel(schema, onAction)
      }
      if (capabilities.includes('game.hooks')) {
        const gh = apis['game.hooks']
        if (!gh) throw new Error(`宿主未授予 ${options.id} game.hooks 能力`)
        hostApis.onBeforeLaunch = (hook) => gh.onBeforeLaunch(hook)
        hostApis.onAfterExit = (hook) => gh.onAfterExit(hook)
      }
      if (capabilities.includes('fs.instance')) {
        const f = apis['fs.instance']
        if (!f) throw new Error(`宿主未授予 ${options.id} fs.instance 能力`)
        hostApis.fsRead = (instanceId, relPath) => f.read(instanceId, relPath)
        hostApis.fsWrite = (instanceId, relPath, content) => f.write(instanceId, relPath, content)
        hostApis.fsList = (instanceId, relPath) => f.list(instanceId, relPath)
        hostApis.fsRemove = (instanceId, relPath) => f.remove(instanceId, relPath)
      }
      if (capabilities.includes('net.domains')) {
        const n = apis['net.domains']
        if (!n) throw new Error(`宿主未授予 ${options.id} net.domains 能力`)
        hostApis.httpRequest = (url, opts) => n.httpRequest(url, opts)
      }

      const toolDisposers: Array<() => void> = []
      let disposed = false
      let sandbox: import('./sandbox').SandboxHandle | null = null
      // 沙箱初始化为异步（activate 可 await 宿主 API）；宿主侧 activate 契约保持同步
      void (async () => {
        try {
          sandbox = await createSandbox({
            code: options.code,
            capabilities,
            ...(Object.keys(hostApis).length > 0 ? { hostApis } : {}),
            ...(options.execTimeoutMs === undefined ? {} : { execTimeoutMs: options.execTimeoutMs }),
            ...(options.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: options.memoryLimitBytes })
          })
          if (disposed) {
            sandbox.dispose()
            return
          }
          const aiTools = apis['ai.tools']
          for (const tool of sandbox.getTools()) {
            const bridge: AiTool = {
              name: tool.name,
              description: tool.description,
              // JSON Schema 根按约定为对象；guest 给出非对象时按空 schema 处理
              parameters: typeof tool.parameters === 'object' && tool.parameters !== null ? (tool.parameters as Record<string, unknown>) : {},
              handler: async (args) => await tool.invoke(args)
            }
            if (aiTools) toolDisposers.push(aiTools.registerTool(bridge))
          }
        } catch (err) {
          console.error(`[components] ${options.id} 沙箱初始化失败：`, err)
        }
      })()
      return () => {
        disposed = true
        toolDisposers.forEach((dispose) => dispose())
        sandbox?.dispose()
      }
    }
  }
}
