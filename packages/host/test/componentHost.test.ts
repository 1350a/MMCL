import { describe, expect, it, vi } from 'vitest'
import type { AiTool } from '@mcl/agent'
import { ComponentHost } from '../src/componentHost'
import type { CoEffectExpr, ComponentContext, HostComponent } from '../src/types'

const tool = (name: string): AiTool => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  handler: async () => name
})

/** 便于测试的最小组件：注册工具 → 探针 → 可选抛错，返回回滚函数。 */
interface TestComponentOptions {
  id: string
  capabilities?: Array<'ai.tools'>
  requires?: string[]
  registerTools?: string[]
  onActivate?: (ctx: ComponentContext) => void
  activateThrows?: boolean
  /** true = 返回的回滚函数什么也不做（模拟组件回滚遗漏）。 */
  leakyDisposer?: boolean
}

const makeComponent = (opts: TestComponentOptions, disposerSpy?: ReturnType<typeof vi.fn>): HostComponent => ({
  manifest: {
    id: opts.id,
    name: opts.id,
    capabilities: opts.capabilities ?? [],
    requires: (opts.requires ?? []) as CoEffectExpr[]
  },
  activate: (ctx) => {
    const disposers: Array<() => void> = []
    for (const name of opts.registerTools ?? []) {
      const api = ctx.capabilities['ai.tools']
      if (!api) throw new Error(`组件 ${opts.id} 未被授予 ai.tools`)
      disposers.push(api.registerTool(tool(name)))
    }
    opts.onActivate?.(ctx)
    if (opts.activateThrows) throw new Error('activate failed')
    if (opts.leakyDisposer) return () => undefined
    return () => disposerSpy?.()
  }
})

describe('ComponentHost', () => {
  it('依赖满足时注册即激活，上下文携带 componentId 与已声明能力', () => {
    const seen: ComponentContext[] = []
    const host = new ComponentHost()
    host.register(
      makeComponent({ id: 'a', capabilities: ['ai.tools'], onActivate: (ctx) => seen.push(ctx) })
    )
    expect(host.listComponents()).toEqual([
      { id: 'a', name: 'a', manifest: expect.any(Object), state: 'active' }
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0].componentId).toBe('a')
    expect(seen[0].capabilities['ai.tools']).toBeDefined()
  })

  it('未声明的能力不会被注入（宿主强制而非组件自觉）', () => {
    const seen: ComponentContext[] = []
    const host = new ComponentHost()
    host.register(makeComponent({ id: 'a', onActivate: (ctx) => seen.push(ctx) }))
    expect(seen[0].capabilities['ai.tools']).toBeUndefined()
  })

  it('协效应不满足则保持停用；满足后激活；再丢失即停用并回滚', () => {
    const disposer = vi.fn()
    const changes: string[] = []
    const host = new ComponentHost({
      onChange: (info) => changes.push(`${info.id}:${info.state}:${info.reason ?? '-'}`)
    })
    host.register(
      makeComponent(
        { id: 'a', requires: ['ai.configured'], capabilities: ['ai.tools'], registerTools: ['t1'] },
        disposer
      )
    )
    expect(host.listComponents()[0].state).toBe('inactive')
    expect(host.getTools()).toEqual([])
    host.setCoEffect('ai.configured', true)
    expect(host.listComponents()[0].state).toBe('active')
    expect(host.getTools().map((t) => t.name)).toEqual(['t1'])
    host.setCoEffect('ai.configured', false)
    expect(host.listComponents()[0].state).toBe('inactive')
    expect(disposer).toHaveBeenCalledTimes(1)
    expect(changes).toEqual(['a:active:-', 'a:inactive:co-effect'])
  })

  it('卸载即回滚：注销工具并调用组件回滚函数', () => {
    const disposer = vi.fn()
    const host = new ComponentHost()
    host.register(makeComponent({ id: 'a', capabilities: ['ai.tools'], registerTools: ['t1'] }, disposer))
    expect(host.getTools().map((t) => t.name)).toEqual(['t1'])
    host.unregister('a')
    expect(disposer).toHaveBeenCalledTimes(1)
    expect(host.getTools()).toEqual([])
    expect(host.listComponents()).toEqual([])
  })

  it('未注册的 id 卸载时静默返回', () => {
    const host = new ComponentHost()
    expect(() => host.unregister('nope')).not.toThrow()
  })

  it('跨组件工具重名注册被拒绝', () => {
    const host = new ComponentHost()
    host.register(makeComponent({ id: 'a', capabilities: ['ai.tools'], registerTools: ['t1'] }))
    host.register(
      makeComponent({
        id: 'b',
        capabilities: ['ai.tools'],
        onActivate: (ctx) => {
          const api = ctx.capabilities['ai.tools']!
          expect(() => api.registerTool(tool('t1'))).toThrowError(/已被组件 a 注册/)
          expect(() => api.registerTool(tool('t2'))).not.toThrow()
        }
      })
    )
  })

  it('组件停用不影响其他组件的工具', () => {
    const host = new ComponentHost()
    host.register(
      makeComponent({ id: 'a', requires: ['ai.configured'], capabilities: ['ai.tools'], registerTools: ['t-a'] })
    )
    host.register(makeComponent({ id: 'b', capabilities: ['ai.tools'], registerTools: ['t-b'] }))
    expect(host.getTools().map((t) => t.name)).toEqual(['t-b'])
    host.setCoEffect('ai.configured', true)
    expect(host.getTools().map((t) => t.name)).toEqual(['t-a', 't-b'])
    host.setCoEffect('ai.configured', false)
    expect(host.getTools().map((t) => t.name)).toEqual(['t-b'])
  })

  it('宿主强制清理：组件回滚遗漏也不残留效应', () => {
    const host = new ComponentHost()
    host.register(
      makeComponent({
        id: 'a',
        requires: ['ai.configured'],
        capabilities: ['ai.tools'],
        registerTools: ['t1'],
        leakyDisposer: true
      })
    )
    host.setCoEffect('ai.configured', true)
    host.setCoEffect('ai.configured', false)
    expect(host.getTools()).toEqual([])
    // 效应已清理：其他组件可注册同名工具
    host.register(makeComponent({ id: 'b', capabilities: ['ai.tools'], registerTools: ['t1'] }))
    expect(host.getTools().map((t) => t.name)).toEqual(['t1'])
  })

  it('activate 抛错：错误上抛、保持未激活、半注册效应被清理', () => {
    const host = new ComponentHost()
    expect(() =>
      host.register(
        makeComponent({ id: 'a', capabilities: ['ai.tools'], registerTools: ['t1'], activateThrows: true })
      )
    ).toThrowError('activate failed')
    expect(host.listComponents()[0].state).toBe('inactive')
    expect(host.getTools()).toEqual([])
    host.register(makeComponent({ id: 'b', capabilities: ['ai.tools'], registerTools: ['t1'] }))
    expect(host.getTools().map((t) => t.name)).toEqual(['t1'])
  })

  it('manifest 校验：未知能力 / 未知协效应 / 重复 id / 缺 id', () => {
    const host = new ComponentHost()
    expect(() => host.register(makeComponent({ id: 'x', capabilities: ['made.up'] as never }))).toThrowError(/未知能力/)
    expect(() => host.register(makeComponent({ id: 'x', requires: ['foo.bar'] }))).toThrowError(/未知协效应/)
    host.register(makeComponent({ id: 'x' }))
    expect(() => host.register(makeComponent({ id: 'x' }))).toThrowError(/已注册/)
    expect(() => host.register(makeComponent({ id: '' }))).toThrowError(/缺少有效 id/)
  })

  it('setCoEffect 校验表达式；参数化协效应 instance.exists:<id> 可用', () => {
    const host = new ComponentHost()
    expect(() => host.setCoEffect('foo.bar' as never, true)).toThrowError(/未知协效应/)
    expect(() => host.setCoEffect('instance.exists:' as never, true)).toThrowError(/未知协效应/)
    host.register(
      makeComponent({ id: 'a', requires: ['instance.exists:main'], capabilities: ['ai.tools'], registerTools: ['t1'] })
    )
    expect(host.getTools()).toEqual([])
    host.setCoEffect('instance.exists:main', true)
    expect(host.getTools().map((t) => t.name)).toEqual(['t1'])
  })

  it('setCoEffect 真值未变化时不重复激活', () => {
    const disposer = vi.fn()
    const host = new ComponentHost()
    const onActivate = vi.fn()
    host.register(makeComponent({ id: 'a', onActivate }, disposer))
    host.setCoEffect('ai.configured', false)
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(disposer).not.toHaveBeenCalled()
  })
})

describe('ComponentHost（M5-4 CapabilityProviders）', () => {
  const compWith = (id: string, capabilities: Array<'ui.panel' | 'game.hooks' | 'fs.instance' | 'net.domains'>, extra: Record<string, unknown> = {}): HostComponent => ({
    manifest: {
      id,
      name: id,
      capabilities: capabilities as never,
      requires: [],
      ...extra
    },
    activate: (ctx) => {
      void ctx
      return () => undefined
    }
  })

  it('provider 授予：上下文含 provider API；revoke 随停用/卸载强制执行', () => {
    const revokes: Array<{ id: string; reason?: string }> = []
    const host = new ComponentHost({
      providers: {
        'ui.panel': (componentId) => ({
          api: {
            mountPanel: () => () => undefined
          },
          revoke: (reason) => revokes.push({ id: componentId, reason })
        })
      }
    })
    const seen: Array<Record<string, unknown>> = []
    const comp = compWith('p1', ['ui.panel'])
    comp.activate = (ctx) => {
      seen.push({ granted: !!ctx.capabilities['ui.panel'] })
      return () => undefined
    }
    host.register(comp)
    expect(seen[0].granted).toBe(true)
    host.setCoEffect('game.notRunning', false) // no-op，不触发
    host.unregister('p1')
    expect(revokes).toEqual([{ id: 'p1', reason: 'unregistered' }])
  })

  it('声明了无 provider 的能力 → register 拒绝；co-effect 停用也 revoke（带原因）', () => {
    const host = new ComponentHost({})
    expect(() => host.register(compWith('p2', ['fs.instance']))).toThrowError(/宿主未提供该能力的实现/)

    const reasons: Array<string | undefined> = []
    const host2 = new ComponentHost({
      providers: {
        'game.hooks': (componentId) => ({
          api: { onBeforeLaunch: () => () => undefined, onAfterExit: () => () => undefined },
          revoke: (reason) => reasons.push(reason)
        })
      }
    })
    host2.register(compWith('p3', ['game.hooks'], { requires: ['ai.configured'] }))
    host2.setCoEffect('ai.configured', true)
    host2.setCoEffect('ai.configured', false)
    expect(reasons).toEqual(['co-effect'])
  })

  it('manifest 作用域校验：fs.instance 无 fsInstances 拒绝；net.domains 非法主机名拒绝', () => {
    const host = new ComponentHost({
      providers: {
        'fs.instance': (id) => ({ api: new Proxy({} as never, {}), revoke: () => undefined }),
        'net.domains': (id) => ({ api: new Proxy({} as never, {}), revoke: () => undefined })
      }
    })
    expect(() => host.register(compWith('f1', ['fs.instance']))).toThrowError(/fsInstances 缺失或含非法实例 id/)
    expect(() => host.register(compWith('f2', ['fs.instance'], { fsInstances: ['../evil'] }))).toThrowError(
      /fsInstances 缺失或含非法实例 id/
    )
    expect(() =>
      host.register(compWith('f3', ['fs.instance'], { fsInstances: ['main', 'skyblock'] }))
    ).not.toThrow()
    expect(() => host.register(compWith('n1', ['net.domains']))).toThrowError(/netDomains 缺失或含非法主机名/)
    expect(() => host.register(compWith('n2', ['net.domains'], { netDomains: ['not a host'] }))).toThrowError(
      /netDomains 缺失或含非法主机名/
    )
    expect(() => host.register(compWith('n3', ['net.domains'], { netDomains: ['api.example.com'] }))).not.toThrow()
  })
})
