import type { AiTool } from '@mcl/agent'
import type { HostComponent } from '@mcl/host'
import { createSandbox } from './sandbox'

export interface SandboxComponentOptions {
  /** 组件 id（内建沙箱组件建议 sandbox. 前缀）。 */
  id: string
  name: string
  /** 扩展 bundle JS（约定 globalThis.__MCL_ENTRY__ = { activate(ctx) }）。 */
  code: string
  /** 单次执行的墙上时间片（毫秒），缺省用沙箱默认值。 */
  execTimeoutMs?: number
  /** 内存限制字节（单次分配语义），缺省用沙箱默认值。 */
  memoryLimitBytes?: number
}

/**
 * 把沙箱扩展包装为 HostComponent：activate 内启动沙箱跑扩展 activate，
 * 沙箱注册的工具经宿主能力面（ai.tools）转为 AiTool——扩展与内建组件无 API 等级差。
 * 卸载链：组件注销 → 本组件 disposer（dispose 沙箱）→ ComponentHost 兜底清理（双保险）。
 */
export function createSandboxComponent(options: SandboxComponentOptions): HostComponent {
  return {
    manifest: {
      id: options.id,
      name: options.name,
      capabilities: ['ai.tools'],
      requires: []
    },
    activate: (ctx) => {
      const api = ctx.capabilities['ai.tools']
      if (!api) throw new Error(`宿主未授予 ${options.id} ai.tools 能力`)
      const sandbox = createSandbox({
        code: options.code,
        capabilities: ['ai.tools'],
        ...(options.execTimeoutMs === undefined ? {} : { execTimeoutMs: options.execTimeoutMs }),
        ...(options.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: options.memoryLimitBytes })
      })
      const disposers = sandbox.getTools().map((tool) =>
        api.registerTool({
          name: tool.name,
          description: tool.description,
          // JSON Schema 根按约定为对象；guest 给出非对象时按空 schema 处理
          parameters: typeof tool.parameters === 'object' && tool.parameters !== null ? (tool.parameters as Record<string, unknown>) : {},
          handler: async (args) => tool.invoke(args)
        } satisfies AiTool)
      )
      return () => {
        disposers.forEach((dispose) => dispose())
        sandbox.dispose()
      }
    }
  }
}
