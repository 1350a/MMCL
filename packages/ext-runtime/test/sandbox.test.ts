import { describe, expect, it, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  memoizePromiseFactory,
  newQuickJSAsyncWASMModuleFromVariant,
  TestQuickJSWASMModule
} from 'quickjs-emscripten-core'
import DEBUG_ASYNCIFY from '@jitl/quickjs-wasmfile-debug-asyncify'
import type { AiTool } from '@mcl/agent'
import type { SandboxHostApis } from '../src'
import { createSandbox, initExtRuntime } from '../src'

/** 样例扩展：注册一个回显工具（纯计算）。 */
const ECHO_EXT = `globalThis.__MCL_ENTRY__ = {
  async activate(ctx) {
    ctx.capabilities['ai.tools'].registerTool({
      name: 'echo_tool',
      description: '回显工具',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async handler(args) {
        const text = String(args.text === undefined ? '' : args.text)
        return JSON.stringify({ echo: text, len: text.length })
      }
    })
  }
}`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * DEBUG-asyncify 变体套件（功能测试）。注意：QuickJSAsyncRuntime.newContext 丢弃
 * options.ownedLifetimes（库限制），TestQuickJSWASMModule 的 context 追踪失效，
 * assertNoMemoryAllocated 会必然误报——宿主侧句柄泄漏由 disposeAll 的
 * vm.dispose()（存活句柄即抛）报警兜底。
 */
describe('sandbox（DEBUG-asyncify 变体）', () => {
  const newDebugModule = memoizePromiseFactory(() => newQuickJSAsyncWASMModuleFromVariant(DEBUG_ASYNCIFY))
  const SLOW = 10_000
  let testModule: TestQuickJSWASMModule

  beforeEach(async () => {
    testModule = new TestQuickJSWASMModule(await newDebugModule())
  })

  it('注册往返：async handler 经桥执行且工具 marshal 到宿主', async () => {
    const sandbox = await createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    const tools = sandbox.getTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('echo_tool')
    expect(tools[0].parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } } })
    expect(JSON.parse(await tools[0].invoke({ text: '你好' }))).toEqual({ echo: '你好', len: 2 })
    sandbox.dispose()
  })

  it('未授予能力：ctx.capabilities 为空（宿主强制跨沙箱成立）', async () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        if (ctx.capabilities && ctx.capabilities['ai.tools']) throw new Error('不应授予 ai.tools')
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: [], execTimeoutMs: SLOW }, testModule)
    sandbox.dispose()
  })

  it('重名注册被拒绝', async () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        const api = ctx.capabilities['ai.tools']
        api.registerTool({ name: 't1', description: '', parameters: {}, handler: () => '"1"' })
        api.registerTool({ name: 't1', description: '', parameters: {}, handler: () => '"1"' })
      }
    }`
    await expect(
      createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    ).rejects.toThrowError(/t1 已注册/)
  })

  it('activate 抛错：createSandbox 抛可读错误', async () => {
    const code = `globalThis.__MCL_ENTRY__ = { async activate() { throw new Error('boom 内部错') } }`
    await expect(createSandbox({ code, capabilities: [], execTimeoutMs: SLOW }, testModule)).rejects.toThrowError(
      /boom 内部错/
    )
  })

  it('缺少 activate 入口', async () => {
    await expect(
      createSandbox({ code: 'globalThis.__MCL_ENTRY__ = {}', capabilities: [], execTimeoutMs: SLOW }, testModule)
    ).rejects.toThrowError(/activate/)
  })

  it('guest 异常转可读错误（async handler 抛错）', async () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'boom', description: '', parameters: {},
          async handler() { throw new Error('扩展内部炸了') }
        })
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    await expect(sandbox.getTools()[0].invoke({})).rejects.toThrowError(/扩展内部炸了/)
    sandbox.dispose()
  })

  it('dispose 幂等；销毁后调用报「沙箱已销毁」', async () => {
    const sandbox = await createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    sandbox.dispose()
    expect(() => sandbox.dispose()).not.toThrow()
    expect(() => sandbox.getTools()).toThrowError(/沙箱已销毁/)
  })

  it('重复调用 20 次无句柄泄漏（afterEach 兜底断言）', async () => {
    const sandbox = await createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'], execTimeoutMs: SLOW }, testModule)
    const tool = sandbox.getTools()[0]
    for (let i = 0; i < 20; i++) await tool.invoke({ text: String(i) })
    sandbox.dispose()
  })

  it('asyncify 桥：guest async handler await 宿主 API（异步 fake）', async () => {
    // 宿主原语：fsRead 300ms 后返回；guest handler await 它再返回
    const hostApis: SandboxHostApis = {
      fsRead: async (instanceId, relPath) => {
        await sleep(300)
        return `data:${instanceId}/${relPath}`
      },
      fsWrite: async () => undefined,
      fsList: async () => [],
      fsRemove: async () => undefined
    }
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'remote_echo', description: '', parameters: {},
          async handler(args) {
            const out = await ctx.capabilities['fs.instance'].read(args.instanceId, args.relPath)
            return JSON.stringify({ via: out })
          }
        })
      }
    }`
    const sandbox = await createSandbox(
      { code, capabilities: ['ai.tools', 'fs.instance'], hostApis, execTimeoutMs: SLOW },
      testModule
    )
    const out = JSON.parse(await sandbox.getTools()[0].invoke({ instanceId: 'main', relPath: 'x.txt' }))
    expect(out.via).toBe('data:main/x.txt')
    sandbox.dispose()
  })

  it('声明了能力但宿主未提供原语 → activate 失败', async () => {
    const code = `globalThis.__MCL_ENTRY__ = { async activate(ctx) {} }`
    await expect(
      createSandbox({ code, capabilities: ['net.domains'], execTimeoutMs: SLOW }, testModule)
    ).rejects.toThrowError(/net\.domains 原语/)
  })
})

describe('sandbox（RELEASE asyncify 生产变体）', () => {
  beforeAll(async () => {
    await initExtRuntime()
  })

  it('生产路径：注册 + 调用往返', async () => {
    const sandbox = await createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'] })
    expect(sandbox.getTools()[0].name).toBe('echo_tool')
    expect(JSON.parse(await sandbox.getTools()[0].invoke({ text: 'prod' }))).toEqual({ echo: 'prod', len: 4 })
    sandbox.dispose()
  })

  it('工具执行超时（时间片中断，guest 空转）', async () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'spin', description: '', parameters: {},
          async handler() { while (true) {} }
        })
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: ['ai.tools'], execTimeoutMs: 50 })
    await expect(sandbox.getTools()[0].invoke({})).rejects.toThrowError(/超时（超过 50ms）/)
    sandbox.dispose()
  })

  it('单次分配超内存限制', async () => {
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        ctx.capabilities['ai.tools'].registerTool({
          name: 'hog', description: '', parameters: {},
          async handler() { const a = new Array(1 << 26).fill(0); return String(a.length) }
        })
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: ['ai.tools'], memoryLimitBytes: 1 << 20 })
    await expect(sandbox.getTools()[0].invoke({})).rejects.toThrowError()
    sandbox.dispose()
  })

  it('重复调用 100 次结果稳定', async () => {
    const sandbox = await createSandbox({ code: ECHO_EXT, capabilities: ['ai.tools'] })
    const tool = sandbox.getTools()[0]
    for (let i = 0; i < 100; i++) {
      expect(JSON.parse(await tool.invoke({ text: String(i) }))).toEqual({ echo: String(i), len: String(i).length })
    }
    sandbox.dispose()
  })

  it('ui.panel 往返：schema marshal + button action 回沙箱 + disposer 撤板', async () => {
    const mounted: Array<{ schema: unknown; onAction: (action: string) => Promise<void> }> = []
    const hostApis: SandboxHostApis = {
      mountPanel: (schema, onAction) => {
        mounted.push({ schema, onAction })
        return () => {
          mounted.length = 0
        }
      }
    }
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        let clicks = 0
        const mount = () => ctx.capabilities['ui.panel'].mountPanel(
          { title: '计数器', items: [{ type: 'text', content: '点击 ' + clicks + ' 次' }, { type: 'button', label: '+1', action: 'inc' }] },
          async function (action) { if (action === 'inc') clicks++; await mount() }
        )
        await mount()
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: ['ui.panel'], hostApis })
    expect(mounted).toHaveLength(1)
    expect((mounted[0].schema as { title: string }).title).toBe('计数器')
    expect((mounted[0].schema as { items: Array<{ type: string }> }).items[1].type).toBe('button')
    // 按钮点击 → 宿主 onAction → guest 回调 → 重新 mount（fake 不去重，追加一条）
    await mounted[0].onAction('inc')
    await sleep(20)
    expect(mounted).toHaveLength(2)
    expect((mounted[1].schema as { items: Array<{ content: string }> }).items[0].content).toBe('点击 1 次')
    sandbox.dispose()
    expect(mounted).toHaveLength(0) // disposer 撤板
  })

  it('game.hooks 往返：追加 jvmArgs / 抛错否决 / afterExit', async () => {
    let beforeHook: ((ctx: { versionId: string; jvmArgs: string[] }) => Promise<string[] | void>) | null = null
    let afterHook: ((ctx: { versionId: string; code: number | null }) => Promise<void>) | null = null
    const hostApis: SandboxHostApis = {
      onBeforeLaunch: (hook) => {
        beforeHook = hook
        return () => {
          beforeHook = null
        }
      },
      onAfterExit: (hook) => {
        afterHook = hook
        return () => undefined
      }
    }
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        ctx.capabilities['game.hooks'].onBeforeLaunch(function (ctx) {
          if (ctx.versionId === 'veto-me') throw new Error('扩展否决：测试版本')
          return ['-Xmx2G', '-Dext=1']
        })
        ctx.capabilities['game.hooks'].onAfterExit(async function (ctx) {
          globalThis.__EXIT_CODE__ = ctx.code
        })
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: ['game.hooks'], hostApis })
    expect(beforeHook).not.toBeNull()
    expect(await beforeHook!({ versionId: '1.16.5', jvmArgs: [] })).toEqual(['-Xmx2G', '-Dext=1'])
    await expect(beforeHook!({ versionId: 'veto-me', jvmArgs: [] })).rejects.toThrowError(/扩展否决/)
    await afterHook!({ versionId: '1.16.5', code: 0 })
    sandbox.dispose()
  })

  it('fs.instance 往返：宿主代理读写 + 逃逸拒绝 + 越权实例拒绝', async () => {
    const files = new Map<string, string>()
    const hostApis: SandboxHostApis = {
      fsRead: async (instanceId, relPath) => {
        if (relPath.includes('..')) throw new Error(`路径越界：${relPath}`)
        return files.get(instanceId + '/' + relPath) ?? ''
      },
      fsWrite: async (instanceId, relPath, content) => {
        if (relPath.includes('..')) throw new Error(`路径越界：${relPath}`)
        files.set(instanceId + '/' + relPath, content)
      },
      fsList: async () => [],
      fsRemove: async () => undefined
    }
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        const fs = ctx.capabilities['fs.instance']
        ctx.capabilities['ai.tools'].registerTool({
          name: 'note_write', description: '', parameters: {},
          async handler(args) { await fs.write('main', args.path, args.content); return '"ok"' }
        })
        ctx.capabilities['ai.tools'].registerTool({
          name: 'note_read', description: '', parameters: {},
          async handler(args) { return JSON.stringify({ content: await fs.read('main', args.path) }) }
        })
        ctx.capabilities['ai.tools'].registerTool({
          name: 'note_escape', description: '', parameters: {},
          async handler(args) { await fs.read('main', args.path); return '"no-veto"' }
        })
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: ['ai.tools', 'fs.instance'], hostApis })
    const tools = new Map(sandbox.getTools().map((t) => [t.name, t]))
    await tools.get('note_write')!.invoke({ path: 'notes/a.txt', content: '你好' })
    expect(files.get('main/notes/a.txt')).toBe('你好')
    expect(JSON.parse(await tools.get('note_read')!.invoke({ path: 'notes/a.txt' }))).toEqual({ content: '你好' })
    await expect(tools.get('note_escape')!.invoke({ path: '../evil.txt' })).rejects.toThrowError(/路径越界/)
    sandbox.dispose()
  })

  it('net.domains：白名单外拒绝；白名单内走注入 fetch；私网 URL 拒绝', async () => {
    const urls: string[] = []
    const hostApis: SandboxHostApis = {
      httpRequest: async (url) => {
        urls.push(url)
        if (url.includes('127.0.0.1')) throw new Error('SSRF 拒绝')
        if (!url.includes('api.example.com')) throw new Error('不在白名单')
        return { status: 200, body: '{"ok":true}' }
      }
    }
    const code = `globalThis.__MCL_ENTRY__ = {
      async activate(ctx) {
        const net = ctx.capabilities['net.domains']
        ctx.capabilities['ai.tools'].registerTool({
          name: 'fetch_api', description: '', parameters: {},
          async handler(args) {
            const res = await net.httpRequest(args.url, { method: 'GET' })
            return JSON.stringify(res)
          }
        })
      }
    }`
    const sandbox = await createSandbox({ code, capabilities: ['ai.tools', 'net.domains'], hostApis })
    const tool = sandbox.getTools()[0]
    const ok = JSON.parse(await tool.invoke({ url: 'https://api.example.com/v1/data' }))
    expect(ok).toEqual({ status: 200, body: '{"ok":true}' })
    await expect(tool.invoke({ url: 'https://evil.example.org/x' })).rejects.toThrowError(/不在白名单/)
    await expect(tool.invoke({ url: 'http://127.0.0.1:8080/x' })).rejects.toThrowError(/SSRF 拒绝/)
    sandbox.dispose()
    void new Map<string, AiTool>() // 引用保持 import 完整性
  })
})
