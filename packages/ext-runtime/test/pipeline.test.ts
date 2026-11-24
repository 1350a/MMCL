import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComponentHost } from '@mcl/host'
import {
  createCapabilityProviders,
  ensureDemoExtension,
  ExtensionPipeline,
  initExtRuntime,
  loadExtensionFromDir
} from '../src'
import type { ExtensionSummary } from '../src'

/** 合法扩展源码：bracket 形态访问 ai.tools（与静态扫描形态一致）。 */
const GREET_CODE = `export function activate(ctx) {
  ctx.capabilities['ai.tools'].registerTool({
    name: 'greet_tool',
    description: '问好工具',
    parameters: { type: 'object', properties: { who: { type: 'string' } } },
    handler(args) {
      return JSON.stringify({ hello: String(args.who || 'world') })
    }
  })
}`

const GREET_CODE_V2 = GREET_CODE.replace("'greet_tool'", "'greet_tool_v2'")

interface ProposalManifest {
  id: string
  name: string
  version: string
  capabilities: string[]
  requires: string[]
}

const manifestOf = (id: string, version: string): ProposalManifest => ({
  id,
  name: '流水线测试扩展',
  version,
  capabilities: ['ai.tools'],
  requires: []
})

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcl-pipeline-test-'))
  await initExtRuntime()
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 每个用例独立的扩展根目录 + 宿主 + 流水线（notify/面板事件汇入同一事件流）。 */
async function makeScope(name: string): Promise<{
  extensionsDir: string
  host: ComponentHost
  pipeline: ExtensionPipeline
  events: Array<{ channel: string; payload: unknown }>
}> {
  const scope = join(root, name)
  const extensionsDir = join(scope, 'extensions')
  await mkdir(extensionsDir, { recursive: true })
  const events: Array<{ channel: string; payload: unknown }> = []
  const notify = (channel: string, payload: unknown): void => {
    events.push({ channel, payload })
  }
  const host = new ComponentHost({
    providers: createCapabilityProviders({ send: notify, instanceDirFor: (id) => join(scope, 'instances', id) }).providers
  })
  const pipeline = new ExtensionPipeline({ extensionsDir, host, notify })
  return { extensionsDir, host, pipeline, events }
}

/** M5-4 起沙箱组件激活异步完成（工具注册稍后），轮询就绪。 */
async function waitFor(desc: string, fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${desc}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const byId = (list: ExtensionSummary[], id: string): ExtensionSummary | undefined => list.find((e) => e.id === id)
const marker = (dir: string): boolean => existsSync(join(dir, '.disabled'))

describe('ExtensionPipeline.submit', () => {
  it('结构校验拒绝：非法 id / builtin. 前缀 / sandbox.demo 占用 / 空 code', async () => {
    const { pipeline, extensionsDir } = await makeScope('reject-structure')
    await expect(pipeline.submit({ id: 'bad id!', name: 'x', capabilities: ['ai.tools'] }, GREET_CODE)).rejects.toThrow(
      /manifest\.id 非法/
    )
    await expect(pipeline.submit({ ...manifestOf('builtin.evil', '0.1.0') }, GREET_CODE)).rejects.toThrow(/builtin\. 开头/)
    await expect(pipeline.submit({ ...manifestOf('sandbox.demo', '0.1.0') }, GREET_CODE)).rejects.toThrow(
      /sandbox\.demo 被内置示例扩展占用/
    )
    await expect(pipeline.submit(manifestOf('my.empty', '0.1.0'), '   ')).rejects.toThrow(/code 不能为空/)
    expect(pipeline.list()).toEqual([])
    expect(existsSync(join(extensionsDir, 'my.empty'))).toBe(false)
  })

  it('一致性失败拒绝（undeclared / unused），错误可读且不落盘', async () => {
    const { pipeline, extensionsDir } = await makeScope('reject-consistency')
    await expect(
      pipeline.submit(
        manifestOf('my.mismatch', '0.1.0'),
        `export function activate(ctx) { ctx.capabilities['ui.panel'].mountPanel({}, function () {}) }`
      )
    ).rejects.toThrow(/未声明的能力：ui\.panel/)
    await expect(
      pipeline.submit(
        { ...manifestOf('my.mismatch', '0.1.0'), capabilities: ['ai.tools', 'ui.panel'] },
        GREET_CODE
      )
    ).rejects.toThrow(/声明了但源码未访问的能力：ui\.panel/)
    expect(pipeline.list()).toEqual([])
    expect(existsSync(join(extensionsDir, 'my.mismatch'))).toBe(false)
  })

  it('语法错误拒绝（esbuild 试打包），不落盘', async () => {
    const { pipeline, extensionsDir } = await makeScope('reject-syntax')
    const broken = `export function activate(ctx) {
  ctx.capabilities['ai.tools'].registerTool(tool)
  this is not js
}`
    await expect(pipeline.submit(manifestOf('my.broken', '0.1.0'), broken)).rejects.toThrow(/扩展打包失败/)
    expect(pipeline.list()).toEqual([])
    expect(existsSync(join(extensionsDir, 'my.broken'))).toBe(false)
  })

  it('默认生成即保存但不装载：落盘 + .disabled 标记 + 清单 disabled', async () => {
    const { pipeline, host, extensionsDir, events } = await makeScope('save-only')
    const result = await pipeline.submit(manifestOf('my.first', '0.1.0'), GREET_CODE)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('未加载')

    const dir = join(extensionsDir, 'my.first')
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
      id: 'my.first',
      version: '0.1.0'
    })
    expect(await readFile(join(dir, 'index.ts'), 'utf8')).toBe(GREET_CODE)
    expect(marker(dir)).toBe(true)
    expect(byId(pipeline.list(), 'my.first')).toMatchObject({ state: 'disabled', enabled: false })
    expect(host.listComponents().some((c) => c.id === 'my.first')).toBe(false)

    const changes = events.filter((e) => e.channel === 'event:ext-list-changed')
    expect(changes.length).toBeGreaterThan(0)
    expect((changes.at(-1)?.payload as ExtensionSummary[])[0]).toMatchObject({ id: 'my.first', enabled: false })

    // 无待审槽：可连续提交第二个扩展
    await pipeline.submit(manifestOf('my.second', '0.1.0'), GREET_CODE)
    expect(pipeline.list()).toHaveLength(2)
  })

  it('autoLoad=true 时立即注册并移除 .disabled；工具经沙箱异步注册后可见', async () => {
    const { pipeline, host, extensionsDir } = await makeScope('auto-load')
    await pipeline.submit(manifestOf('my.greet', '0.1.0'), GREET_CODE, { autoLoad: true })
    const dir = join(extensionsDir, 'my.greet')
    expect(marker(dir)).toBe(false)
    expect(byId(pipeline.list(), 'my.greet')).toMatchObject({ enabled: true, state: 'active' })
    await waitFor('greet_tool 注册', () => host.getTools().some((t) => t.name === 'greet_tool'))
    expect(JSON.parse(await host.getTools()[0].handler({ who: 'MCL' }))).toEqual({ hello: 'MCL' })
  })
})

describe('ExtensionPipeline.enable / disable', () => {
  it('启用已保存扩展 → 注册；停用 → 注销 + 标记；可再次启用', async () => {
    const { pipeline, host, extensionsDir } = await makeScope('toggle-flow')
    const dir = join(extensionsDir, 'my.toggle')
    await pipeline.submit(manifestOf('my.toggle', '0.1.0'), GREET_CODE)
    expect(byId(pipeline.list(), 'my.toggle')?.enabled).toBe(false)

    await pipeline.enable('my.toggle')
    expect(byId(pipeline.list(), 'my.toggle')?.enabled).toBe(true)
    expect(marker(dir)).toBe(false)
    await waitFor('启用后工具注册', () => host.getTools().some((t) => t.name === 'greet_tool'))

    await pipeline.disable('my.toggle')
    expect(byId(pipeline.list(), 'my.toggle')).toMatchObject({ state: 'disabled', enabled: false })
    expect(marker(dir)).toBe(true)
    expect(host.getTools().some((t) => t.name === 'greet_tool')).toBe(false)

    await pipeline.enable('my.toggle')
    await waitFor('再次启用后工具注册', () => host.getTools().some((t) => t.name === 'greet_tool'))
  })

  it('未安装 id / 非法 id 拒绝启用与停用', async () => {
    const { pipeline } = await makeScope('toggle-guard')
    await expect(pipeline.enable('my.never')).rejects.toThrow(/my\.never 未安装/)
    await expect(pipeline.disable('my.never')).rejects.toThrow(/my\.never 未安装/)
    await expect(pipeline.enable('')).rejects.toThrow(/invalid extension id/)
    await expect(pipeline.disable('')).rejects.toThrow(/invalid extension id/)
  })
})

describe('ExtensionPipeline.loadInstalled', () => {
  it('启动恢复：无标记的装载，有 .disabled 的只登记不装载', async () => {
    const { pipeline, extensionsDir } = await makeScope('load-installed')
    await pipeline.submit(manifestOf('my.off', '0.1.0'), GREET_CODE)
    await pipeline.submit(manifestOf('my.on', '0.1.0'), GREET_CODE_V2, { autoLoad: true })

    const events: Array<{ channel: string; payload: unknown }> = []
    const notify = (channel: string, payload: unknown): void => {
      events.push({ channel, payload })
    }
    const host = new ComponentHost({
      providers: createCapabilityProviders({
        send: notify,
        instanceDirFor: (id) => join(root, 'load-installed', 'instances', id)
      }).providers
    })
    const second = new ExtensionPipeline({ extensionsDir, host, notify })
    const result = await second.loadInstalled()
    expect(result).toMatchObject({ loaded: 1, disabled: 1, errors: [] })
    expect(byId(second.list(), 'my.on')?.enabled).toBe(true)
    expect(byId(second.list(), 'my.off')?.enabled).toBe(false)
  })
})

describe('ExtensionPipeline.remove', () => {
  it('卸载 = 注销（工具/面板回滚）+ 目录删除；再装闭环', async () => {
    const { pipeline, host, extensionsDir } = await makeScope('remove-flow')
    const panelCode = `export async function activate(ctx) {
  ctx.capabilities['ui.panel'].mountPanel(
    { title: '测试面板', items: [{ type: 'text', content: 'hi' }] },
    function () {}
  )
  ctx.capabilities['ai.tools'].registerTool({
    name: 'panel_tool', description: 'd',
    parameters: { type: 'object', properties: {} },
    handler() { return '{}' }
  })
}`
    await pipeline.submit(
      { ...manifestOf('my.panel', '0.1.0'), capabilities: ['ai.tools', 'ui.panel'] },
      panelCode,
      { autoLoad: true }
    )
    expect(byId(pipeline.list(), 'my.panel')?.enabled).toBe(true)
    await waitFor('panel_tool 注册', () => host.getTools().some((t) => t.name === 'panel_tool'))

    const removed = await pipeline.remove('my.panel')
    expect(removed.ok).toBe(true)
    expect(byId(pipeline.list(), 'my.panel')).toBeUndefined()
    expect(host.getTools().some((t) => t.name === 'panel_tool')).toBe(false)
    expect(existsSync(join(extensionsDir, 'my.panel'))).toBe(false)

    await pipeline.submit(
      { ...manifestOf('my.panel', '0.1.1'), capabilities: ['ai.tools', 'ui.panel'] },
      panelCode,
      { autoLoad: true }
    )
    await waitFor('重装后工具注册', () => host.getTools().some((t) => t.name === 'panel_tool'))
  })

  it('卸载时面板撤板（宿主强制 revoke，event:panel-changed 推空清单）', async () => {
    const { pipeline, events } = await makeScope('remove-panel')
    const panelCode = `export async function activate(ctx) {
  ctx.capabilities['ui.panel'].mountPanel(
    { title: '测试面板', items: [{ type: 'text', content: 'hi' }] },
    function () {}
  )
}`
    await pipeline.submit(
      { ...manifestOf('my.panel2', '0.1.0'), capabilities: ['ui.panel'] },
      panelCode,
      { autoLoad: true }
    )
    await waitFor('面板挂载', () =>
      events.some((e) => e.channel === 'event:panel-changed' && (e.payload as unknown[]).length > 0)
    )

    await pipeline.remove('my.panel2')
    expect(events.some((e) => e.channel === 'event:panel-changed' && (e.payload as unknown[]).length === 0)).toBe(true)
  })

  it('未安装 id / 非法 id / builtin 前缀拒绝', async () => {
    const { pipeline } = await makeScope('remove-guard')
    await expect(pipeline.remove('my.never')).rejects.toThrow(/my\.never 未安装/)
    await expect(pipeline.remove('')).rejects.toThrow(/invalid extension id/)
    await expect(pipeline.remove('builtin.ai-tools')).rejects.toThrow(/builtin\.ai-tools 未安装/)
  })
})

describe('ExtensionPipeline.list', () => {
  it('builtin.* 内建组件不进清单；落盘注册的 sandbox.demo 进清单', async () => {
    const { host, pipeline, extensionsDir } = await makeScope('list-filter')
    await ensureDemoExtension(extensionsDir)
    const { component } = await loadExtensionFromDir(join(extensionsDir, 'sandbox.demo'))
    host.register(component)
    host.register({
      manifest: { id: 'builtin.other', name: '内建', capabilities: [], requires: [] },
      activate: () => undefined
    })
    const ids = pipeline.list().map((e) => e.id)
    expect(ids).not.toContain('builtin.other')
    expect(ids).toContain('sandbox.demo')
    expect(byId(pipeline.list(), 'sandbox.demo')?.capabilities).toContain('ui.panel')
  })
})
