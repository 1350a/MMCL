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

/** 合法提案源码：bracket 形态访问 ai.tools（与静态扫描形态一致）。 */
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

describe('ExtensionPipeline.submit', () => {
  it('结构校验拒绝：非法 id / builtin. 前缀 / sandbox.demo 占用 / 空 code', async () => {
    const { pipeline } = await makeScope('reject-structure')
    await expect(pipeline.submit({ id: 'bad id!', name: 'x', capabilities: ['ai.tools'] }, GREET_CODE)).rejects.toThrow(
      /manifest\.id 非法/
    )
    await expect(pipeline.submit({ ...manifestOf('builtin.evil', '0.1.0') }, GREET_CODE)).rejects.toThrow(/builtin\. 开头/)
    await expect(pipeline.submit({ ...manifestOf('sandbox.demo', '0.1.0') }, GREET_CODE)).rejects.toThrow(/sandbox\.demo 被内置示例扩展占用/)
    await expect(pipeline.submit(manifestOf('my.empty', '0.1.0'), '   ')).rejects.toThrow(/code 不能为空/)
    expect(pipeline.getPending()).toBeNull()
  })

  it('一致性失败拒绝（undeclared / unused），错误可读且不入槽', async () => {
    const { pipeline } = await makeScope('reject-consistency')
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
    expect(pipeline.getPending()).toBeNull()
  })

  it('语法错误拒绝（esbuild 试打包），不入槽', async () => {
    const { pipeline } = await makeScope('reject-syntax')
    // 能力访问与声明一致（过一致性检查），但代码本身语法错误 → 打包期拒绝
    const broken = `export function activate(ctx) {
  ctx.capabilities['ai.tools'].registerTool(tool)
  this is not js
}`
    await expect(pipeline.submit(manifestOf('my.broken', '0.1.0'), broken)).rejects.toThrow(/扩展打包失败/)
    expect(pipeline.getPending()).toBeNull()
  })

  it('合法提案入槽并通知 event:ext-pending；槽占用即拒', async () => {
    const { pipeline } = await makeScope('slot')
    const result = await pipeline.submit(manifestOf('my.first', '0.1.0'), GREET_CODE)
    expect(result.ok).toBe(true)
    expect(pipeline.getPending()?.manifest.id).toBe('my.first')
    expect(pipeline.getPending()?.code).toBe(GREET_CODE)
    expect(pipeline.list()).toEqual([]) // 未 approve 不注册
    await expect(pipeline.submit(manifestOf('my.second', '0.1.0'), GREET_CODE)).rejects.toThrow(/已有待审核的扩展提案（my\.first）/)
  })
})

describe('ExtensionPipeline.approve / reject', () => {
  it('无提案时 approve/reject 报错', async () => {
    const { pipeline } = await makeScope('no-pending')
    await expect(pipeline.approve()).rejects.toThrow(/没有待审核的扩展提案/)
    expect(() => pipeline.reject()).toThrow(/没有待审核的扩展提案/)
  })

  it('reject 清槽零残留（未落盘未注册），可再次提交', async () => {
    const { pipeline, extensionsDir, events } = await makeScope('reject-flow')
    await pipeline.submit(manifestOf('my.rejected', '0.1.0'), GREET_CODE)
    const rejected = pipeline.reject()
    expect(rejected.ok).toBe(true)
    expect(pipeline.getPending()).toBeNull()
    expect(existsSync(join(extensionsDir, 'my.rejected'))).toBe(false)
    expect(pipeline.list()).toEqual([])
    await pipeline.submit(manifestOf('my.rejected', '0.1.0'), GREET_CODE) // 清槽后可再提交
    expect(pipeline.getPending()?.manifest.id).toBe('my.rejected')
    expect(events.some((e) => e.channel === 'event:ext-pending' && e.payload !== null)).toBe(true)
    expect(events.some((e) => e.channel === 'event:ext-pending' && e.payload === null)).toBe(true)
  })

  it('并发初始化两个沙箱扩展：asyncify 单挂起约束下都能激活（回归：Already suspended）', async () => {
    const { pipeline, host } = await makeScope('concurrent-init')
    const code = (toolName: string) => `export async function activate(ctx) {
  ctx.capabilities['ai.tools'].registerTool({
    name: '${toolName}', description: 'd',
    parameters: { type: 'object', properties: {} },
    handler() { return '{}' }
  })
  ctx.capabilities['ui.panel'].mountPanel(
    { title: '${toolName}', items: [{ type: 'text', content: 'hi' }] },
    function () {}
  )
}`
    // 两次 approve 背靠背：a1 的沙箱初始化是 fire-and-forget，a2 的初始化与之并发
    await pipeline.submit({ ...manifestOf('my.a1', '0.1.0'), capabilities: ['ai.tools', 'ui.panel'] }, code('tool_a1'))
    await pipeline.approve()
    await pipeline.submit({ ...manifestOf('my.a2', '0.1.0'), capabilities: ['ai.tools', 'ui.panel'] }, code('tool_a2'))
    await pipeline.approve()
    await waitFor('两个工具都注册', () => host.getTools().filter((t) => t.name.startsWith('tool_')).length === 2)
    expect(host.getTools().map((t) => t.name).sort()).toEqual(['tool_a1', 'tool_a2'])
  })

  it('approve 落盘 + 注册 + 工具可见 + event:ext-list-changed（端到端真沙箱）', async () => {
    const { pipeline, host, extensionsDir } = await makeScope('approve-flow')
    await pipeline.submit(manifestOf('my.greet', '0.1.0'), GREET_CODE)
    const approved = await pipeline.approve()
    expect(approved.ok).toBe(true)

    // 落盘：manifest.json + index.ts，内容与提案一致
    const dir = join(extensionsDir, 'my.greet')
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ id: 'my.greet', version: '0.1.0' })
    expect(await readFile(join(dir, 'index.ts'), 'utf8')).toBe(GREET_CODE)

    // 注册且激活；工具经沙箱异步注册后可见
    const summary = byId(pipeline.list(), 'my.greet')
    expect(summary?.state).toBe('active')
    await waitFor('greet_tool 注册', () => host.getTools().some((t) => t.name === 'greet_tool'))
    expect(JSON.parse(await host.getTools()[0].handler({ who: 'MCL' }))).toEqual({ hello: 'MCL' })

    // 清槽 + 清单推送
    expect(pipeline.getPending()).toBeNull()
    expect(host.listComponents().map((c) => c.id)).toContain('my.greet')
  })

  it('更新语义：同 id 提交 v0.2.0 → approve 先注销旧版再注册新版', async () => {
    const { pipeline, host } = await makeScope('update-flow')
    await pipeline.submit(manifestOf('my.greet', '0.1.0'), GREET_CODE)
    await pipeline.approve()
    await waitFor('v1 工具注册', () => host.getTools().some((t) => t.name === 'greet_tool'))

    await pipeline.submit(manifestOf('my.greet', '0.2.0'), GREET_CODE_V2)
    await pipeline.approve()
    const entries = host.listComponents().filter((c) => c.id === 'my.greet')
    expect(entries).toHaveLength(1)
    expect(entries[0].manifest.version).toBe('0.2.0')
    await waitFor('v2 工具替换', () => host.getTools().some((t) => t.name === 'greet_tool_v2'))
    expect(host.getTools().some((t) => t.name === 'greet_tool')).toBe(false) // 旧工具不残留
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
      panelCode
    )
    await pipeline.approve()
    expect(byId(pipeline.list(), 'my.panel')?.state).toBe('active')
    await waitFor('panel_tool 注册', () => host.getTools().some((t) => t.name === 'panel_tool'))

    const removed = await pipeline.remove('my.panel')
    expect(removed.ok).toBe(true)
    expect(byId(pipeline.list(), 'my.panel')).toBeUndefined() // 清单消失
    expect(host.getTools().some((t) => t.name === 'panel_tool')).toBe(false) // 工具回滚
    expect(existsSync(join(extensionsDir, 'my.panel'))).toBe(false) // 目录删除

    await pipeline.submit({ ...manifestOf('my.panel', '0.1.1'), capabilities: ['ai.tools', 'ui.panel'] }, panelCode) // 卸载后可重装
    await pipeline.approve()
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
      panelCode
    )
    await pipeline.approve()
    await waitFor('面板挂载', () => events.some((e) => e.channel === 'event:panel-changed' && (e.payload as unknown[]).length > 0))

    await pipeline.remove('my.panel2')
    expect(events.some((e) => e.channel === 'event:panel-changed' && (e.payload as unknown[]).length === 0)).toBe(true)
  })

  it('未注册 id / 非法 id 拒绝', async () => {
    const { pipeline } = await makeScope('remove-guard')
    await expect(pipeline.remove('my.never')).rejects.toThrow(/my\.never 未注册/)
    await expect(pipeline.remove('')).rejects.toThrow(/invalid extension id/)
    await expect(pipeline.remove('builtin.ai-tools')).rejects.toThrow(/builtin\.ai-tools 未注册/) // 内建组件不进管理面
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
