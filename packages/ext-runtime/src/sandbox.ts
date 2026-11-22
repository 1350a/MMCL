import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule
} from 'quickjs-emscripten-core'
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync'

/**
 * 沙箱工具契约（M5-2）：guest handler 同步返回 JSON 字符串。
 * 异步宿主调用桥（asyncify）随 M5-4 能力面引入，届时 handler 才可 await 宿主 API。
 */
export type SandboxCapability = 'ai.tools'

export interface SandboxOptions {
  /** 扩展 bundle JS；约定执行后 `globalThis.__MCL_ENTRY__ = { activate(ctx) }`。 */
  code: string
  /** 授予的能力清单（宿主强制：清单外的 API 不注入沙箱上下文）。 */
  capabilities: SandboxCapability[]
  /** 单次执行的墙上时间片（毫秒），默认 1000。 */
  execTimeoutMs?: number
  /**
   * setMemoryLimit 字节数，默认 32MB。
   * 已知语义（quickjs-emscripten#271）：约束单次分配而非运行时总量，不承诺总内存上限。
   */
  memoryLimitBytes?: number
}

/** 沙箱工具 marshal 后的宿主可见形态。 */
export interface SandboxTool {
  name: string
  description: string
  /** JSON Schema。 */
  parameters: unknown
  /** 进入 VM 执行 handler（同步；超时/guest 异常以可读 Error 抛出）。 */
  invoke(args: Record<string, unknown>): string
}

export interface SandboxHandle {
  getTools(): SandboxTool[]
  /** 销毁沙箱：释放全部句柄与 VM。幂等；销毁后 invoke/getTools 报「沙箱已销毁」。 */
  dispose(): void
}

const DEFAULT_EXEC_TIMEOUT_MS = 1000
const DEFAULT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024
const DEFAULT_STACK_BYTES = 1024 * 1024

let modulePromise: Promise<void> | null = null
let moduleCached: QuickJSWASMModule | null = null

/** 加载并缓存 QuickJS WASM 模块（进程级一次；重复调用复用首次结果）。 */
export function initExtRuntime(): Promise<void> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(RELEASE_SYNC).then((m) => {
      moduleCached = m
    })
  }
  return modulePromise
}

/** 已初始化的模块；显式传入 module（测试注入 DEBUG 变体）时优先用传入值。 */
function requireModule(explicit?: SandboxModule): SandboxModule {
  if (explicit) return explicit
  if (!moduleCached) throw new Error('扩展运行时未初始化：请先 await initExtRuntime()')
  return moduleCached
}

type EvalResult = ReturnType<QuickJSContext['evalCode']>

/** 沙箱需要的模块能力面（生产 QuickJSWASMModule 与测试用 TestQuickJSWASMModule 均满足）。 */
type SandboxModule = Pick<QuickJSWASMModule, 'newContext'>

interface ToolEntry {
  name: string
  description: string
  parameters: unknown
  /** guest handler 函数句柄（由沙箱持有，注销/销毁时释放）。 */
  handler: QuickJSHandle
  invoke(args: Record<string, unknown>): string
}

/**
 * 创建沙箱并执行扩展的 activate。
 * - 时间片：每次执行窗口（eval / activate / invokeTool）前设墙上时钟 deadline，
 *   interrupt handler 轮询超时即中断（WASM 内测不了纯 CPU 时间）；
 * - 句柄纪律：getProp 产物用完即释放；沙箱自建句柄记入 retained 表随 dispose 统一释放；
 *   返回给 guest 的句柄（如 registerTool 的注销函数）不进 retained——其宿主侧包装由库释放；
 * - 类型检查一律 vm.dump 落到宿主侧判断（DEBUG 变体的 vm.typeof 每次调用漏 8 字节，
 *   会触发泄漏断言，故不用）。
 */
export function createSandbox(options: SandboxOptions, module?: SandboxModule): SandboxHandle {
  const mod = requireModule(module)
  const execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES

  // module.newContext：context 自带 runtime（随 context 释放）；mod.newRuntime() 的
  // 泄漏追踪回调在 TestQuickJSWASMModule 下不触发，会误报
  const vm: QuickJSContext = mod.newContext()
  const runtime: QuickJSRuntime = vm.runtime
  runtime.setMemoryLimit(memoryLimitBytes)
  runtime.setMaxStackSize(DEFAULT_STACK_BYTES)
  let deadline = 0
  runtime.setInterruptHandler(() => deadline > 0 && Date.now() > deadline)

  const retained: QuickJSHandle[] = []
  const tools = new Map<string, ToolEntry>()
  let disposed = false

  /** 每个执行窗口套一层 deadline；窗口结束清零（interrupt handler 只在窗口内生效）。 */
  const withDeadline = <T>(fn: () => T): T => {
    deadline = Date.now() + execTimeoutMs
    try {
      return fn()
    } finally {
      deadline = 0
    }
  }

  /** guest 异常归一化：中断 → 超时错误；其余 → 带 guest message 的可读错误。 */
  const readable = (err: unknown, what: string): Error => {
    const e = err instanceof Error ? err : new Error(String(err))
    if (e.message === 'interrupted') {
      return new Error(`${what}超时（超过 ${execTimeoutMs}ms）`)
    }
    return new Error(`${what}失败：${e.message}`)
  }

  /** unwrapResult 包装：错误分支转可读异常；成功返回值句柄（调用方负责释放）。 */
  const unwrap = (result: EvalResult, what: string): QuickJSHandle => {
    try {
      return vm.unwrapResult<QuickJSHandle>(result)
    } catch (err) {
      throw readable(err, what)
    }
  }

  /** 一次性 guest 表达式求值并取宿主值（结果句柄即用即释）。 */
  const evalHost = (expr: string, what: string): unknown => {
    const h = unwrap(withDeadline(() => vm.evalCode(expr, 'check.js')), what)
    try {
      return vm.dump(h)
    } finally {
      h.dispose()
    }
  }

  /** 排水 QuickJS 微任务队列（guest 的 Promise 不会自行 resume）；有界防无限 job。 */
  const drainJobs = (what: string): void => {
    try {
      vm.unwrapResult(runtime.executePendingJobs(1000))
    } catch (err) {
      throw readable(err, what)
    }
  }

  /** 宿主 JSON 数据 → VM 句柄：双重 stringify 后经 guest JSON.parse 构造，无注入面。 */
  const marshal = (value: Record<string, unknown>, what: string): QuickJSHandle => {
    const json = JSON.stringify(value)
    return unwrap(
      withDeadline(() => vm.evalCode(`JSON.parse(${JSON.stringify(json)})`, 'marshal.js')),
      what
    )
  }

  const assertAlive = (): void => {
    if (disposed) throw new Error('沙箱已销毁')
  }

  /** 释放全部句柄与 VM（vm.dispose 遇存活句柄会抛错——句柄簿记 bug 的报警器）。 */
  const disposeAll = (): void => {
    for (const t of tools.values()) t.handler.dispose()
    tools.clear()
    for (const h of retained) h.dispose()
    retained.length = 0
    vm.dispose() // context 释放时连带释放其 runtime
  }

  try {
    const entryHandle = unwrap(
      withDeadline(() => vm.evalCode(options.code, 'extension.js', { type: 'global' })),
      '扩展代码执行'
    )
    retained.push(entryHandle)
    if (evalHost('typeof (globalThis.__MCL_ENTRY__ || {}).activate', '扩展入口检查') !== 'function') {
      throw new Error('扩展缺少 activate(ctx) 入口（约定 globalThis.__MCL_ENTRY__ = { activate(ctx) }）')
    }
    const activateHandle = vm.getProp(entryHandle, 'activate')
    retained.push(activateHandle)

    // 能力上下文：结构对齐宿主 ComponentContext（ctx.capabilities['ai.tools']）
    const ctxObj = vm.newObject()
    retained.push(ctxObj)
    if (options.capabilities.includes('ai.tools')) {
      const capsObj = vm.newObject()
      retained.push(capsObj)
      const aiToolsObj = vm.newObject()
      retained.push(aiToolsObj)
      const registerToolFn = vm.newFunction('registerTool', (defHandle) => {
        const nameH = vm.getProp(defHandle, 'name')
        const descH = vm.getProp(defHandle, 'description')
        const paramsH = vm.getProp(defHandle, 'parameters')
        const handlerH = vm.getProp(defHandle, 'handler')
        let owned = false
        try {
          const name = vm.dump(nameH)
          if (typeof name !== 'string' || name.length === 0) throw new Error('工具缺少有效 name')
          if (tools.has(name)) throw new Error(`工具 ${name} 已注册`)
          const description = vm.dump(descH)
          const parameters = vm.dump(paramsH)
          const invoke = (args: Record<string, unknown>): string => {
            assertAlive()
            const argsHandle = marshal(args, `扩展工具 ${name} 参数构造`)
            try {
              const value = unwrap(
                withDeadline(() => vm.callFunction(handlerH, vm.undefined, argsHandle)),
                `扩展工具 ${name} 执行`
              )
              try {
                drainJobs(`扩展工具 ${name}`)
                const out = vm.dump(value)
                if (typeof out !== 'string') throw new Error(`扩展工具 ${name} 需返回字符串（JSON）`)
                return out
              } finally {
                value.dispose()
              }
            } finally {
              argsHandle.dispose()
            }
          }
          const disposer = vm.newFunction(`${name}.unregister`, () => {
            const t = tools.get(name)
            if (t) {
              tools.delete(name)
              t.handler.dispose()
            }
          })
          tools.set(name, {
            name,
            description: typeof description === 'string' ? description : '',
            parameters,
            handler: handlerH,
            invoke
          })
          owned = true
          return disposer // 交给 guest 持有；宿主侧包装由库在调用后释放，不进 retained
        } finally {
          nameH.dispose()
          descH.dispose()
          paramsH.dispose()
          if (!owned) handlerH.dispose()
        }
      })
      retained.push(registerToolFn)
      vm.setProp(aiToolsObj, 'registerTool', registerToolFn)
      vm.setProp(capsObj, 'ai.tools', aiToolsObj)
      vm.setProp(ctxObj, 'capabilities', capsObj)
    }

    const result = unwrap(
      withDeadline(() => vm.callFunction(activateHandle, vm.undefined, ctxObj)),
      '扩展 activate 执行'
    )
    result.dispose()
    drainJobs('扩展 activate')
  } catch (err) {
    disposeAll()
    throw err instanceof Error ? err : new Error(String(err))
  }

  return {
    getTools(): SandboxTool[] {
      assertAlive()
      return [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        invoke: t.invoke
      }))
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      disposeAll()
    }
  }
}
