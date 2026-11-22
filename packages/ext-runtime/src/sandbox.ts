import { newQuickJSAsyncWASMModuleFromVariant } from 'quickjs-emscripten-core'
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSHandle,
  QuickJSWASMModule
} from 'quickjs-emscripten-core'
import RELEASE_ASYNC from '@jitl/quickjs-wasmfile-release-asyncify'
import type {
  AfterExitContext,
  BeforeLaunchContext,
  CapabilityId,
  NetRequestOptions,
  NetResponse,
  PanelSchema
} from '@mcl/host'
import type { AiTool } from '@mcl/agent'

/**
 * 沙箱工具契约（M5-4）：guest handler 可为 async（经 asyncify 桥 await 宿主 API），
 * 最终返回 JSON 字符串。异步宿主调用桥即本文件的 asyncified 能力注入。
 */
export type SandboxCapability = CapabilityId

/**
 * 宿主原语面：沙箱 VM 侧能力注入的宿主实现（由 createSandboxComponent 从
 * ComponentHost 能力授予桥接而来；未提供却声明了对应能力 → activate 失败）。
 */
export interface SandboxHostApis {
  mountPanel?(schema: PanelSchema, onAction: (action: string) => Promise<void>): () => void
  onBeforeLaunch?(hook: (ctx: BeforeLaunchContext) => Promise<string[] | void>): () => void
  onAfterExit?(hook: (ctx: AfterExitContext) => Promise<void>): () => void
  fsRead?(instanceId: string, relPath: string): Promise<string>
  fsWrite?(instanceId: string, relPath: string, content: string): Promise<void>
  fsList?(instanceId: string, relPath: string): Promise<string[]>
  fsRemove?(instanceId: string, relPath: string): Promise<void>
  httpRequest?(url: string, options?: NetRequestOptions): Promise<NetResponse>
}

export interface SandboxOptions {
  /** 扩展 bundle JS；约定执行后 `globalThis.__MCL_ENTRY__ = { activate(ctx) }`。 */
  code: string
  /** 授予的能力清单（宿主强制：清单外的 API 不注入沙箱上下文）。 */
  capabilities: CapabilityId[]
  /** 宿主原语（声明 ui.panel/game.hooks/fs.instance/net.domains 时必需）。 */
  hostApis?: SandboxHostApis
  /** 单次 guest 计算窗口的墙上时间片（毫秒），默认 1000；宿主 I/O 悬挂期不计片。 */
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
  /** 进入 VM 执行 handler（async：guest 可 await 宿主 API）；超时/guest 异常以可读 Error 抛出。 */
  invoke(args: Record<string, unknown>): Promise<string>
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
    modulePromise = newQuickJSAsyncWASMModuleFromVariant(RELEASE_ASYNC).then((m) => {
      moduleCached = m
    })
  }
  return modulePromise
}

/** 已初始化的模块；显式传入 module（测试注入 DEBUG 变体）时优先用传入值。 */
function requireModule(explicit?: Pick<QuickJSWASMModule, 'newContext'>): Pick<QuickJSWASMModule, 'newContext'> {
  if (explicit) return explicit
  if (!moduleCached) throw new Error('扩展运行时未初始化：请先 await initExtRuntime()')
  return moduleCached
}

type EvalResult = Awaited<ReturnType<QuickJSAsyncContext['evalCodeAsync']>>

interface ToolEntry {
  name: string
  description: string
  parameters: unknown
  /** guest handler 句柄（由沙箱持有，注销/销毁时释放）。 */
  handler: QuickJSHandle
  invoke(args: Record<string, unknown>): Promise<string>
}

/**
 * 创建沙箱并执行扩展的 activate（async：activate 可 await 宿主 API）。
 * - 时间片：guest 计算窗口内 interrupt 轮询；asyncified 宿主调用悬挂期不计片
 *   （deadline 置 0，返回后恢复）——I/O 延迟不占片，guest 空转仍会被打断；
 * - 句柄纪律：getProp 产物用完即释放；自建句柄记入 retained 随 dispose 释放；
 *   返回给 guest 的句柄不进 retained（其宿主侧包装由库释放）；
 * - asyncified 宿主回调期间禁止执行 guest 代码：marshal 一律直接构造句柄
 *   （true/false/null 用初始化时的常量句柄），调用 guest 回调走临时全局槽 + evalCodeAsync。
 */
export async function createSandbox(
  options: SandboxOptions,
  module?: Pick<QuickJSWASMModule, 'newContext'>
): Promise<SandboxHandle> {
  const mod = requireModule(module)
  const execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES

  const vm = mod.newContext() as QuickJSAsyncContext
  const runtime: QuickJSAsyncRuntime = vm.runtime
  runtime.setMemoryLimit(memoryLimitBytes)
  runtime.setMaxStackSize(DEFAULT_STACK_BYTES)
  let deadline = 0
  runtime.setInterruptHandler(() => deadline > 0 && Date.now() > deadline)

  const retained: QuickJSHandle[] = []
  const tools = new Map<string, ToolEntry>()
  /** 沙箱登记的宿主效应回滚（面板/钩子注销）：沙箱销毁时强制执行。 */
  const effectDisposers: Array<() => void> = []
  let disposed = false

  const assertAlive = (): void => {
    if (disposed) throw new Error('沙箱已销毁')
  }

  /** guest 计算窗口套 deadline；宿主 I/O 悬挂期经 hostCall 暂停计片。 */
  const withDeadline = <T>(fn: () => T | Promise<T>): T | Promise<T> => {
    deadline = Date.now() + execTimeoutMs
    const restore = (): void => {
      deadline = 0
    }
    try {
      const out = fn()
      if (out instanceof Promise) {
        // 异步窗口：完成时恢复（悬挂段已由 hostCall 单独暂停，这里只管 guest 段）
        return out.finally(restore) as T
      }
      restore()
      return out
    } catch (err) {
      restore()
      throw err
    }
  }

  /** 宿主 I/O 悬挂期：暂停时间片（interrupt 不生效），完成后恢复。 */
  const hostCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    const saved = deadline
    deadline = 0
    try {
      return await fn()
    } finally {
      deadline = saved
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

  const unwrap = (result: EvalResult, what: string): QuickJSHandle => {
    try {
      return vm.unwrapResult<QuickJSHandle>(result)
    } catch (err) {
      throw readable(err, what)
    }
  }

  /** guest 代码一次性求值并取宿主值（结果句柄即用即释）。 */
  const evalHost = async (expr: string, what: string): Promise<unknown> => {
    const h = unwrap(await withDeadline(() => vm.evalCodeAsync(expr, 'check.js')), what)
    try {
      return vm.dump(h)
    } finally {
      h.dispose()
    }
  }

  /**
   * 宿主值 → VM 句柄：直接构造（setProp 不执行 guest 代码），asyncified 回调内安全。
   * null/布尔用初始化期常量句柄（true/false/null 无法用 new* API 构造）。
   */
  const marshalValue = (value: unknown): QuickJSHandle => {
    if (value === null) return constHandles.null
    if (value === undefined) return vm.undefined
    if (typeof value === 'boolean') return value ? constHandles.true : constHandles.false
    if (typeof value === 'string') return vm.newString(value)
    if (typeof value === 'number') return vm.newNumber(value)
    if (Array.isArray(value)) {
      const arr = vm.newArray()
      for (let i = 0; i < value.length; i++) {
        const h = marshalValue(value[i])
        vm.setProp(arr, i, h)
        h.dispose()
      }
      return arr
    }
    if (typeof value === 'object') {
      const obj = vm.newObject()
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const h = marshalValue(v)
        vm.setProp(obj, k, h)
        h.dispose()
      }
      return obj
    }
    throw new Error(`桥接 marshal 不支持的类型 ${typeof value}`)
  }

  /**
   * 结果若是 Promise-like（guest async 函数）则驱动到落定。resolvePromise 注册的
   * guest .then 回调是 pending job，必须并发排水才会落定（否则永久挂起）；
   * 排水窗口内套时间片（guest 在 await 之间的空转仍会被打断）。
   */
  const resolveToValue = async (handle: QuickJSHandle, what: string): Promise<QuickJSHandle> => {
    const thenH = vm.getProp(handle, 'then')
    const thenDump = vm.dump(thenH)
    thenH.dispose()
    if (thenDump === undefined || thenDump === null) return handle
    const settled = vm.resolvePromise(handle)
    let draining = true
    const drain = (async () => {
      while (draining) {
        deadline = Date.now() + execTimeoutMs
        let res: Awaited<ReturnType<QuickJSAsyncRuntime['executePendingJobs']>>
        try {
          res = runtime.executePendingJobs(256)
        } finally {
          deadline = 0
        }
        if (typeof res !== 'number') {
          // job 出错（guest async 体内抛错）：promise 会以 reject 落定，交 unwrap 转可读
          break
        }
        if (res === 0) await new Promise<void>((r2) => setTimeout(r2, 2))
      }
    })()
    try {
      return unwrap(await settled, what)
    } finally {
      draining = false
      await drain.catch(() => undefined)
    }
  }

  /**
   * 调用 guest 回调（onAction / 钩子 / 工具 handler）：临时全局槽 + evalCodeAsync
   * （async 上下文中唯一能处理 guest 悬挂的调用方式），返回值 dump 为宿主值。
   */
  const callGuestFn = async (fn: QuickJSHandle, arg: unknown, what: string): Promise<unknown> => {
    assertAlive()
    vm.setProp(vm.global, '__MCL_TMP_FN__', fn)
    const argH = marshalValue(arg)
    vm.setProp(vm.global, '__MCL_TMP_ARG__', argH)
    argH.dispose()
    try {
      const result = unwrap(
        await withDeadline(() =>
          vm.evalCodeAsync('globalThis.__MCL_TMP_FN__(globalThis.__MCL_TMP_ARG__)', 'bridge-call.js')
        ),
        what
      )
      const value = await resolveToValue(result, what)
      const out = vm.dump(value)
      if (value !== result) value.dispose()
      return out
    } finally {
      vm.setProp(vm.global, '__MCL_TMP_FN__', vm.undefined)
      vm.setProp(vm.global, '__MCL_TMP_ARG__', vm.undefined)
    }
  }

  /** 释放全部句柄与 VM（vm.dispose 遇存活句柄会抛错——句柄簿记 bug 的报警器）。 */
  const disposeAll = (): void => {
    for (const t of tools.values()) t.handler.dispose()
    tools.clear()
    // 宿主效应回滚：面板撤板、钩子注销（组件层 revoke 之外的双保险）
    for (const d of effectDisposers) d()
    effectDisposers.length = 0
    for (const h of retained) h.dispose()
    retained.length = 0
    vm.dispose() // context 释放时连带释放其 runtime
  }

  /** 初始化期常量句柄（true/false/null 无 new* 构造 API）。 */
  const constHandles = {
    true: vm.unwrapResult(await vm.evalCodeAsync('true', 'init.js')),
    false: vm.unwrapResult(await vm.evalCodeAsync('false', 'init.js')),
    null: vm.unwrapResult(await vm.evalCodeAsync('null', 'init.js'))
  }
  retained.push(constHandles.true, constHandles.false, constHandles.null)

  try {
    // 执行扩展代码。入口不从 evalCode 完成值取（esbuild IIFE 产物完成值不可靠），
    // 一律从 globalThis.__MCL_ENTRY__ 读：var 声明与显式赋值都落在全局。
    const completionValue = unwrap(
      await withDeadline(() => vm.evalCodeAsync(options.code, 'extension.js', { type: 'global' })),
      '扩展代码执行'
    )
    completionValue.dispose()
    const entryCheck = await evalHost('typeof (globalThis.__MCL_ENTRY__ || {}).activate', '扩展入口检查')
    if (entryCheck !== 'function') {
      throw new Error('扩展缺少 activate(ctx) 入口（约定 globalThis.__MCL_ENTRY__ = { activate(ctx) }）')
    }
    const entryHandle = vm.getProp(vm.global, '__MCL_ENTRY__')
    retained.push(entryHandle)
    const activateHandle = vm.getProp(entryHandle, 'activate')
    retained.push(activateHandle)

    // 能力上下文：结构对齐宿主 ComponentContext（ctx.capabilities['<id>']），只注入声明且宿主可桥接的能力
    const declared = new Set(options.capabilities)
    const hostApis = options.hostApis ?? {}
    const ctxObj = vm.newObject()
    retained.push(ctxObj)
    const capsObj = vm.newObject()
    retained.push(capsObj)

    // ---- ai.tools（内建）----
    if (declared.has('ai.tools')) {
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
          if (vm.dump(handlerH) === undefined) throw new Error(`工具 ${name} 缺少 handler 函数`)
          if (tools.has(name)) throw new Error(`工具 ${name} 已注册`)
          const description = vm.dump(descH)
          const parameters = vm.dump(paramsH)
          const invoke = async (args: Record<string, unknown>): Promise<string> => {
            assertAlive()
            const out = await callGuestFn(handlerH, args, `扩展工具 ${name} 执行`)
            if (typeof out !== 'string') throw new Error(`扩展工具 ${name} 需返回字符串（JSON）`)
            return out
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
    }

    // ---- ui.panel ----
    if (declared.has('ui.panel')) {
      const mountPanel = hostApis.mountPanel
      if (!mountPanel) throw new Error('宿主未提供 ui.panel 原语，无法授予 ui.panel 能力')
      const uiPanelObj = vm.newObject()
      retained.push(uiPanelObj)
      const mountPanelFn = vm.newAsyncifiedFunction('mountPanel', async (schemaH, onActionH) => {
        const schema = vm.dump(schemaH)
        const onActionH2 = onActionH.dup() // 参数句柄由库释放，留存供后续回呼
        retained.push(onActionH2)
        const onAction = async (action: string): Promise<void> => {
          await callGuestFn(onActionH2, action, '面板 onAction')
        }
        const hostDisposer = mountPanel(schema, onAction)
        effectDisposers.push(hostDisposer)
        let done = false
        return vm.newFunction('unmountPanel', () => {
          if (done) return
          done = true
          const i = effectDisposers.indexOf(hostDisposer)
          if (i >= 0) effectDisposers.splice(i, 1)
          hostDisposer()
        })
      })
      retained.push(mountPanelFn)
      vm.setProp(uiPanelObj, 'mountPanel', mountPanelFn)
      vm.setProp(capsObj, 'ui.panel', uiPanelObj)
    }

    // ---- game.hooks ----
    if (declared.has('game.hooks')) {
      const onBeforeLaunch = hostApis.onBeforeLaunch
      const onAfterExit = hostApis.onAfterExit
      if (!onBeforeLaunch || !onAfterExit) throw new Error('宿主未提供 game.hooks 原语，无法授予 game.hooks 能力')
      const hooksObj = vm.newObject()
      retained.push(hooksObj)
      const beforeFn = vm.newAsyncifiedFunction('onBeforeLaunch', async (hookH) => {
        const hookH2 = hookH.dup()
        retained.push(hookH2)
        const hostDisposer = hostApis.onBeforeLaunch!(async (ctx) => {
          const out = await callGuestFn(hookH2, { versionId: ctx.versionId, jvmArgs: [...ctx.jvmArgs] }, '启动前钩子')
          return Array.isArray(out) ? out.map(String) : undefined
        })
        effectDisposers.push(hostDisposer)
      })
      retained.push(beforeFn)
      vm.setProp(hooksObj, 'onBeforeLaunch', beforeFn)
      const afterFn = vm.newAsyncifiedFunction('onAfterExit', async (hookH) => {
        const hookH2 = hookH.dup()
        retained.push(hookH2)
        const hostDisposer = hostApis.onAfterExit!(async (ctx) => {
          await callGuestFn(hookH2, { versionId: ctx.versionId, code: ctx.code }, '退出后钩子')
        })
        effectDisposers.push(hostDisposer)
      })
      retained.push(afterFn)
      vm.setProp(hooksObj, 'onAfterExit', afterFn)
      vm.setProp(capsObj, 'game.hooks', hooksObj)
    }

    // ---- fs.instance ----
    if (declared.has('fs.instance')) {
      const needed: Array<['fsRead' | 'fsWrite' | 'fsList' | 'fsRemove', string]> = [
        ['fsRead', 'read'],
        ['fsWrite', 'write'],
        ['fsList', 'list'],
        ['fsRemove', 'remove']
      ]
      for (const [name] of needed) {
        if (!hostApis[name]) throw new Error('宿主未提供 fs.instance 原语，无法授予 fs.instance 能力')
      }
      const fsObj = vm.newObject()
      retained.push(fsObj)
      const asyncifiedFs = (name: 'fsRead' | 'fsWrite' | 'fsList' | 'fsRemove'): QuickJSHandle => {
        return vm.newAsyncifiedFunction(name, async (...argHandles) => {
          const args = argHandles.map((h) => vm.dump(h))
          if (name === 'fsWrite' && args.length !== 3) throw new Error(`fs.write 需要 (instanceId, relPath, content)`)
          if (name !== 'fsWrite' && args.length !== 2) throw new Error(`${name} 需要 (instanceId, relPath)`)
          let out: unknown
          if (name === 'fsRead') out = await hostCall(() => hostApis.fsRead!(args[0] as string, args[1] as string))
          if (name === 'fsWrite')
            out = await hostCall(() => hostApis.fsWrite!(args[0] as string, args[1] as string, args[2] as string))
          if (name === 'fsList') out = await hostCall(() => hostApis.fsList!(args[0] as string, args[1] as string))
          if (name === 'fsRemove') out = await hostCall(() => hostApis.fsRemove!(args[0] as string, args[1] as string))
          return marshalValue(out)
        })
      }
      for (const [name, vmName] of needed) {
        const fn = asyncifiedFs(name)
        retained.push(fn)
        vm.setProp(fsObj, vmName, fn)
      }
      vm.setProp(capsObj, 'fs.instance', fsObj)
    }

    // ---- net.domains ----
    if (declared.has('net.domains')) {
      const httpRequest = hostApis.httpRequest
      if (!httpRequest) throw new Error('宿主未提供 net.domains 原语，无法授予 net.domains 能力')
      const netObj = vm.newObject()
      retained.push(netObj)
      const httpRequestFn = vm.newAsyncifiedFunction('httpRequest', async (urlH, optsH) => {
        const url = vm.dump(urlH)
        const opts = optsH ? (vm.dump(optsH) as NetRequestOptions | undefined) : undefined
        const out = await hostCall(() => httpRequest(url as string, opts))
        return marshalValue(out)
      })
      retained.push(httpRequestFn)
      vm.setProp(netObj, 'httpRequest', httpRequestFn)
      vm.setProp(capsObj, 'net.domains', netObj)
    }

    vm.setProp(ctxObj, 'capabilities', capsObj)

    // 调 activate：guest activate 可为 async（可 await 宿主 API），走 evalCodeAsync
    vm.setProp(vm.global, '__MCL_TMP_ARG__', ctxObj)
    try {
      const result = unwrap(
        await withDeadline(() =>
          vm.evalCodeAsync('globalThis.__MCL_ENTRY__.activate(globalThis.__MCL_TMP_ARG__)', 'activate.js')
        ),
        '扩展 activate 执行'
      )
      const value = await resolveToValue(result, '扩展 activate')
      if (value !== result) value.dispose()
    } finally {
      vm.setProp(vm.global, '__MCL_TMP_ARG__', vm.undefined)
    }
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
