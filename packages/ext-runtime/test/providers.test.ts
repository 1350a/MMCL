import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilityProviders } from '../src'
import type { CapabilityRuntime } from '../src'
import type { ComponentManifest } from '@mcl/host'

const manifestWith = (extra: Partial<Omit<ComponentManifest, 'capabilities' | 'requires'>>): ComponentManifest => ({
  id: 'test-ext',
  name: '测试扩展',
  capabilities: [],
  requires: [],
  ...extra
})

describe('providers：ui.panel', () => {
  it('挂载/更新/撤板 + 未知元素拒绝', () => {
    const broadcasts: unknown[] = []
    const runtime: CapabilityRuntime = createCapabilityProviders({
      send: (ch, payload) => {
        broadcasts.push(payload)
      }
    })
    const grant = runtime.providers['ui.panel']!('test-ext', manifestWith({}))
    const disposer = grant.api.mountPanel(
      {
        title: '面板',
        items: [
          { type: 'text', content: 'a' },
          { type: 'kv', rows: { x: '1', y: 2 as unknown as string } },
          { type: 'button', label: 'go', action: 'run' }
        ]
      },
      async () => undefined
    )
    expect(runtime.getPanels()).toHaveLength(1)
    expect(runtime.getPanels()[0].id).toBe('test-ext')
    expect(runtime.getPanels()[0].title).toBe('面板')
    expect(runtime.getPanels()[0].items[0]).toEqual({ type: 'text', content: 'a' })
    // kv 非字符串值转字符串
    expect((runtime.getPanels()[0].items[1] as { rows: Record<string, string> }).rows).toEqual({ x: '1', y: '2' })
    expect(broadcasts.length).toBeGreaterThan(0)
    // 更新（重复 mount 覆盖；旧 disposer 对新面板 no-op）
    const disposer2 = grant.api.mountPanel({ title: '面板 v2', items: [] }, async () => undefined)
    expect(runtime.getPanels()[0].title).toBe('面板 v2')
    disposer()
    expect(runtime.getPanels()).toHaveLength(1)
    disposer2()
    expect(runtime.getPanels()).toEqual([])
    // 未知元素类型
    expect(() => grant.api.mountPanel({ title: 'x', items: [{ type: 'input' } as never] }, async () => undefined)).toThrowError(
      /未知元素类型/
    )
  })

  it('panelAction 转发 onAction；未知面板拒绝', async () => {
    const runtime = createCapabilityProviders({})
    const actions: string[] = []
    const grant = runtime.providers['ui.panel']!('t', manifestWith({}))
    grant.api.mountPanel({ title: 'p', items: [{ type: 'button', label: 'b', action: 'do' }] }, async (action) => {
      actions.push(action)
    })
    await runtime.panelAction('t', 'do')
    expect(actions).toEqual(['do'])
    await expect(runtime.panelAction('nope', 'x')).rejects.toThrowError(/不存在/)
  })
})

describe('providers：game.hooks', () => {
  it('beforeLaunch 按序追加；afterExit 容错；revoke 移除钩子', async () => {
    const runtime = createCapabilityProviders({})
    const g1 = runtime.providers['game.hooks']!('a', manifestWith({}))
    const g2 = runtime.providers['game.hooks']!('b', manifestWith({}))
    g1.api.onBeforeLaunch((ctx) => [`-Dfrom=${ctx.versionId}`])
    g1.api.onBeforeLaunch((ctx) => {
      expect(ctx.jvmArgs).toEqual(['-Dfrom=1.16.5']) // 快照可见已累积参数，返回值只含本钩子新增
      return ['-Xmx2G']
    })
    g2.api.onBeforeLaunch(() => undefined)
    const extra = await runtime.runBeforeLaunch({ versionId: '1.16.5', jvmArgs: [] })
    expect(extra).toEqual(['-Dfrom=1.16.5', '-Xmx2G'])

    const exits: Array<{ versionId: string; code: number | null }> = []
    g1.api.onAfterExit(async (ctx) => {
      exits.push(ctx)
      throw new Error('钩子内部错（应被容错吞掉并记日志）')
    })
    await runtime.runAfterExit({ versionId: '1.16.5', code: 0 })
    expect(exits).toEqual([{ versionId: '1.16.5', code: 0 }])

    // revoke（宿主停用/卸载时强制调用）移除该组件的全部钩子
    g1.revoke('unregistered')
    expect(await runtime.runBeforeLaunch({ versionId: 'x', jvmArgs: [] })).toEqual([])
  })

  it('beforeLaunch 抛错 = 否决启动', async () => {
    const runtime = createCapabilityProviders({})
    const g = runtime.providers['game.hooks']!('a', manifestWith({}))
    g.api.onBeforeLaunch(() => {
      throw new Error('mod 冲突')
    })
    await expect(runtime.runBeforeLaunch({ versionId: '1.16.5', jvmArgs: [] })).rejects.toThrowError(/mod 冲突/)
  })
})

describe('providers：fs.instance', () => {
  let dir: string
  const makeRuntime = (): CapabilityRuntime =>
    createCapabilityProviders({ instanceDirFor: (id) => join(dir, id) })

  const manifest = manifestWith({ fsInstances: ['main'] })

  it('读写 list remove + 补偿记录 + 卸载时输出', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcl-fs-prov-'))
    try {
      const runtime = makeRuntime()
      const grant = runtime.providers['fs.instance']!('test-ext', manifest)
      await grant.api.write('main', 'notes/a.txt', '内容1')
      expect(await grant.api.read('main', 'notes/a.txt')).toBe('内容1')
      expect(await grant.api.list('main', 'notes')).toEqual(['a.txt'])
      await grant.api.remove('main', 'notes/a.txt')
      expect(runtime.getCompensation()).toEqual([
        { componentId: 'test-ext', op: 'write', instanceId: 'main', relPath: 'notes/a.txt', at: expect.any(String) },
        { componentId: 'test-ext', op: 'remove', instanceId: 'main', relPath: 'notes/a.txt', at: expect.any(String) }
      ])
      // 卸载 revoke：补偿清单输出（console），不物理回滚
      grant.revoke('unregistered')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('目录逃逸拒绝；越权实例拒绝', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcl-fs-prov2-'))
    try {
      const runtime = makeRuntime()
      const grant = runtime.providers['fs.instance']!('test-ext', manifest)
      await expect(grant.api.read('main', '../outside.txt')).rejects.toThrowError(/路径越界/)
      await expect(grant.api.read('main', '..\\outside.txt')).rejects.toThrowError(/路径越界/)
      await expect(grant.api.write('other-instance', 'x.txt', 'v')).rejects.toThrowError(/不在本扩展的 fs\.instance 作用域/)
      await expect(grant.api.write('main', 'sub/../ok.txt', 'v')).resolves.toBeUndefined() // 归一化后仍在实例内
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('读写往返走真实文件系统（内容断言）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcl-fs-prov3-'))
    try {
      const runtime = makeRuntime()
      const grant = runtime.providers['fs.instance']!('test-ext', manifest)
      await grant.api.write('main', 'a/b.txt', '中文内容')
      expect(await readFile(join(dir, 'main', 'a', 'b.txt'), 'utf8')).toBe('中文内容')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writeFile 内容隔离：扩展目录不被误伤（writeFile 外部文件后 remove 不受影响）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcl-fs-prov4-'))
    try {
      const outside = join(dir, 'outside.txt')
      await writeFile(outside, 'host-file', 'utf8')
      const runtime = makeRuntime()
      const grant = runtime.providers['fs.instance']!('test-ext', manifest)
      await expect(grant.api.remove('main', '../../outside.txt')).rejects.toThrowError(/路径越界/)
      expect(await readFile(outside, 'utf8')).toBe('host-file')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('providers：net.domains', () => {
  const manifest = manifestWith({ netDomains: ['api.example.com'] })
  const fakeFetch = (impl: (url: string) => { status: number; text: () => Promise<string> }): typeof fetch =>
    ((url: string) => Promise.resolve(impl(String(url)))) as unknown as typeof fetch

  it('白名单内走注入 fetch 并返回 {status, body}', async () => {
    const runtime = createCapabilityProviders({
      fetchImpl: fakeFetch((url) => ({ status: 201, text: async () => `resp:${url}` }))
    })
    const grant = runtime.providers['net.domains']!('t', manifest)
    const out = await grant.api.httpRequest('https://api.example.com/v1/x', { method: 'POST', body: 'hi' })
    expect(out).toEqual({ status: 201, body: 'resp:https://api.example.com/v1/x' })
  })

  it('域名外拒绝；非法 URL 拒绝；非 GET/POST 拒绝', async () => {
    const runtime = createCapabilityProviders({ fetchImpl: fakeFetch(() => ({ status: 200, text: async () => '' })) })
    const grant = runtime.providers['net.domains']!('t', manifest)
    await expect(grant.api.httpRequest('https://evil.org/x')).rejects.toThrowError(/不在白名单/)
    await expect(grant.api.httpRequest('not-a-url')).rejects.toThrowError(/非法 URL/)
    await expect(grant.api.httpRequest('https://api.example.com/x', { method: 'DELETE' })).rejects.toThrowError(
      /暂只支持 GET\/POST/
    )
  })

  it('私网/环回 URL 被 SSRF 校验拒绝（复用 @mcl/core assertSafeRemoteUrl）', async () => {
    const runtime = createCapabilityProviders({ fetchImpl: fakeFetch(() => ({ status: 200, text: async () => '' })) })
    const grant = runtime.providers['net.domains']!('t', manifestWith({ netDomains: ['127.0.0.1', 'localhost'] }))
    await expect(grant.api.httpRequest('http://127.0.0.1:8080/admin')).rejects.toThrowError()
    await expect(grant.api.httpRequest('http://localhost/x')).rejects.toThrowError()
  })

  it('响应体 1MB 截断', async () => {
    const runtime = createCapabilityProviders({
      fetchImpl: fakeFetch(() => ({ status: 200, text: async () => 'x'.repeat(1_100_000) }))
    })
    const grant = runtime.providers['net.domains']!('t', manifest)
    const out = await grant.api.httpRequest('https://api.example.com/big')
    expect(out.body.length).toBe(1_000_000)
  })
})
