import { describe, expect, it, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  memoizePromiseFactory,
  newQuickJSWASMModuleFromVariant,
  TestQuickJSWASMModule
} from 'quickjs-emscripten-core'
import DEBUG_SYNC from '@jitl/quickjs-wasmfile-debug-sync'
import type { AiTool } from '@mcl/agent'
import { createSandbox, createSandboxComponent, initExtRuntime } from '../src'

/** 样例扩展：注册一个回显工具（纯计算）。 */
const ECHO_EXT = `globalThis.__MCL_ENTRY__ = {
  activate(ctx) {
    ctx.capabilities['ai.tools'].registerTool({
      name: 'echo_tool',
      description: '回显工具',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      handler(args) {
        const text = String(args.text === undefined ? '' : args.text)
        return JSON.stringify({ echo: text, len: text.length })
      }
    })
  }
}`

/**
 * DEBUG 变体套件：泄漏检测只对 DEBUG 准确。注意 DEBUG 首次 eval 约 300ms+、
 * 后续 5-16ms，故本套件统一放宽 execTimeoutMs；时间片/内存限制的行为测试放 RELEASE 套件
 * （DEBUG 下 50ms/1MB 的窗口会误杀合法 eval）。
 */
describe('sandbox（DEBUG 变体 + 泄漏检测）', () => {
  const newDebugModule = memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(DEBUG_SYNC))
  const SLOW = 10_000
  let testModule: TestQuickJSWASMModule

  beforeEach(async () => {
    testModule = new TestQuickJSWASMModule(await newDebugModule())
  })

  afterEach(() => {
    testModule.assertNoMemoryAllocated()
  })

  it('注册往返：activate 注册的工具 marshal 到宿主且可调用', () => {
    const sandbox = createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    const tools = sandbox.getTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('echo_tool')
    expect(tools[0].description).toBe('回显工具')
    expect(tools[0].parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } } })
    expect(JSON.parse(tools[0].invoke({ text: '你好' }))).toEqual({ echo: '你好', len: 2 })
    sandbox.dispose()
  })

  it('未授予能力：ctx.capabilities 为空（宿主强制跨沙箱成立）', () => {
    // 扩展自证：若 ai.tools 被注入则抛错 → createSandbox 成功即证明未授予
    const code = `globalThis.__MCL_ENTRY__ = {
      activate(ctx) {
        if (ctx.capabilities && ctx.capabilities['ai.tools']) throw new Error('不应授予 ai.tools')
      }
    }`
    const sandbox = createSandbox({ code, capabilities: [], execTimeoutMs: SLOW }, testModule)
    try {
      // createSandbox 未抛错 = 未授予成立
    } finally {
      sandbox.dispose()
    }
  })

  it('VM 侧注销函数生效且可重新注册同名', () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      activate(ctx) {
        const api = ctx.capabilities['ai.tools']
        api.registerTool({ name: 't1', description: '', parameters: {}, handler: () => '"1"' })
        const d = api.registerTool({ name: 't2', description: '', parameters: {}, handler: () => '"2"' })
        d()
        api.registerTool({ name: 't2', description: 'again', parameters: {}, handler: () => '"22"' })
      }
    }`
    const sandbox = createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    expect(sandbox.getTools().map((t) => t.name)).toEqual(['t1', 't2'])
    expect(sandbox.getTools().find((t) => t.name === 't2')?.description).toBe('again')
    sandbox.dispose()
  })

  it('重名注册被拒绝', () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      activate(ctx) {
        const api = ctx.capabilities['ai.tools']
        api.registerTool({ name: 't1', description: '', parameters: {}, handler: () => '"1"' })
        api.registerTool({ name: 't1', description: '', parameters: {}, handler: () => '"1"' })
      }
    }`
    expect(() =>
      createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    ).toThrowError(/t1 已注册/)
  })

  it('activate 抛错：createSandbox 抛可读错误', () => {
    const code = `globalThis.__MCL_ENTRY__ = { activate() { throw new Error('boom 内部错') } }`
    expect(() => createSandbox({ code, capabilities: [], execTimeoutMs: SLOW }, testModule)).toThrowError(/boom 内部错/)
  })

  it('缺少 activate 入口', () => {
    expect(() =>
      createSandbox({ code: 'globalThis.__MCL_ENTRY__ = {}', capabilities: [], execTimeoutMs: SLOW }, testModule)
    ).toThrowError(/activate/)
  })

  it('handler 返回非字符串被拒绝', () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'bad', description: '', parameters: {}, handler() { return 42 }
        })
      }
    }`
    const sandbox = createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    expect(() => sandbox.getTools()[0].invoke({})).toThrowError(/需返回字符串/)
    sandbox.dispose()
  })

  it('guest 异常转可读错误', () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'boom', description: '', parameters: {},
          handler() { throw new Error('扩展内部炸了') }
        })
      }
    }`
    const sandbox = createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    expect(() => sandbox.getTools()[0].invoke({})).toThrowError(/扩展内部炸了/)
    sandbox.dispose()
  })

  it('dispose 幂等；销毁后调用报「沙箱已销毁」', () => {
    const sandbox = createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    sandbox.dispose()
    expect(() => sandbox.dispose()).not.toThrow()
    expect(() => sandbox.getTools()).toThrowError(/沙箱已销毁/)
  })

  it('重复调用 20 次无句柄泄漏（afterEach 兜底断言）', () => {
    const sandbox = createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    const tool = sandbox.getTools()[0]
    for (let i = 0; i < 20; i++) tool.invoke({ text: String(i) })
    sandbox.dispose()
  })
})

describe('sandbox（RELEASE 生产变体）', () => {
  beforeAll(async () => {
    await initExtRuntime()
  })

  it('生产路径：注册 + 调用往返', () => {
    const sandbox = createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'] })
    expect(sandbox.getTools()[0].name).toBe('echo_tool')
    expect(JSON.parse(sandbox.getTools()[0].invoke({ text: 'prod' }))).toEqual({ echo: 'prod', len: 4 })
    sandbox.dispose()
  })

  it('工具执行超时（时间片中断）', () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'spin', description: '', parameters: {},
          handler() { while (true) {} }
        })
      }
    }`
    const sandbox = createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: 50 })
    expect(() => sandbox.getTools()[0].invoke({})).toThrowError(/超时（超过 50ms）/)
    sandbox.dispose()
  })

  it('单次分配超内存限制', () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'hog', description: '', parameters: {},
          handler() { const a = new Array(1 << 26).fill(0); return String(a.length) }
        })
      }
    }`
    const sandbox = createSandbox({ code, capabilities: ['ai.tools'], memoryLimitBytes: 1 << 20 })
    expect(() => sandbox.getTools()[0].invoke({})).toThrowError()
    sandbox.dispose()
  })

  it('重复调用 100 次结果稳定', () => {
    const sandbox = createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'] })
    const tool = sandbox.getTools()[0]
    for (let i = 0; i < 100; i++) {
      expect(JSON.parse(tool.invoke({ text: String(i) }))).toEqual({ echo: String(i), len: String(i).length })
    }
    sandbox.dispose()
  })

  it('createSandboxComponent 桥接：mock ctx 注册 AiTool 并可调用', async () => {
    const registered: AiTool[] = []
    const component = createSandboxComponent({ id: 'test.sandbox', name: '测试沙箱', code: ECHO_EXT })
    const disposer = component.activate({
      componentId: 'test.sandbox',
      capabilities: {
        'ai.tools': {
          registerTool: (tool) => {
            registered.push(tool)
            return () => undefined
          }
        }
      }
    })
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('echo_tool')
    expect(JSON.parse(await registered[0].handler({ text: 'x' }))).toEqual({ echo: 'x', len: 1 })
    expect(typeof disposer).toBe('function')
    ;(disposer as () => void)()
  })
})
