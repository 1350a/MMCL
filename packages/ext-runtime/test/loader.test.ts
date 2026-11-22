import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComponentHost } from '@mcl/host'
import { ensureDemoExtension, initExtRuntime, scanExtensions } from '../src'
import type { AiTool } from '@mcl/agent'

const ECHO_INDEX_TS = `export function activate(ctx) {
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
`

const manifest = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, name: '回显扩展', capabilities: ['ai.tools'], ...extra })

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcl-ext-test-'))
  await initExtRuntime()
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 每个用例独立的扩展根目录（避免用例间互相污染）。 */
async function makeScope(name: string): Promise<string> {
  const scope = join(root, name)
  await mkdir(scope, { recursive: true })
  return scope
}

/** 在 scope 下建一个扩展目录；manifest 传 null 不写 manifest.json，indexTs 传 null 不写入口。 */
async function makeExt(
  scope: string,
  dirName: string,
  manifestJson: string | null,
  indexTs: string | null = ECHO_INDEX_TS
): Promise<string> {
  const dir = join(scope, dirName)
  await mkdir(dir, { recursive: true })
  if (manifestJson !== null) await writeFile(join(dir, 'manifest.json'), manifestJson)
  if (indexTs !== null) await writeFile(join(dir, 'index.ts'), indexTs)
  return dir
}

/**
 * M5-4 起沙箱初始化为 fire-and-forget（activate 可 await 宿主 API），工具注册稍后
 * 完成——测试用 waitFor 轮询就绪。
 */
async function waitFor(desc: string, fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${desc}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** mock 宿主 ui.tools/ai.tools 授予：收集注册的 AiTool。 */
function collectTools(): { registered: AiTool[]; ctx: Parameters<import('@mcl/host').HostComponent['activate']>[0] } {
  const registered: AiTool[] = []
  return {
    registered,
    ctx: {
      componentId: 'test',
      capabilities: {
        'ai.tools': {
          registerTool: (tool) => {
            registered.push(tool)
            return () => undefined
          }
        }
      }
    }
  }
}

describe('scanExtensions', () => {
  it('合法扩展：装载成功且经 mock ctx 注册的工具可调用（真实 esbuild + 真实沙箱）', async () => {
    const scope = await makeScope('ok')
    await makeExt(scope, 'echo', manifest('echo'))
    const { loaded, errors } = await scanExtensions(scope)
    expect(errors).toEqual([])
    expect(loaded).toHaveLength(1)
    expect(loaded[0].manifest.name).toBe('回显扩展')

    const { registered, ctx } = collectTools()
    loaded[0].component.activate({ ...ctx, componentId: 'echo' })
    await waitFor('echo_tool 注册', () => registered.length > 0)
    expect(registered[0].name).toBe('echo_tool')
    expect(JSON.parse(await registered[0].handler({ text: '你好' }))).toEqual({ echo: '你好', len: 2 })
  })

  it('manifest 结构校验：缺 name / capabilities 非数组 / 未知能力 / 未知协效应 / id 与目录名不一致', async () => {
    const scope = await makeScope('validation')
    // 注意：manifest 助手总是带 name——缺 name 场景用原始 JSON 构造
    await makeExt(scope, 'bad-name', JSON.stringify({ id: 'bad-name', capabilities: ['ai.tools'] }))
    await makeExt(scope, 'bad-caps', manifest('bad-caps', { capabilities: 'ai.tools' }))
    await makeExt(scope, 'unknown-cap', manifest('unknown-cap', { capabilities: ['made.up.cap'] }))
    await makeExt(scope, 'bad-req', manifest('bad-req', { requires: ['foo.bar'] }))
    await makeExt(scope, 'mismatch', manifest('other'))
    const { loaded, errors } = await scanExtensions(scope)
    expect(loaded).toEqual([])
    const reasons = errors.map((e) => e.reason)
    expect(reasons.some((r) => /缺少有效 name/.test(r))).toBe(true)
    expect(reasons.some((r) => /capabilities 需为数组/.test(r))).toBe(true)
    expect(reasons.some((r) => /未知能力 made\.up\.cap/.test(r))).toBe(true)
    expect(reasons.some((r) => /未知协效应 foo\.bar/.test(r))).toBe(true)
    expect(reasons.some((r) => /与目录名（mismatch）不一致/.test(r))).toBe(true)
  })

  it('打包失败（语法错误）：errors 含文件与行列定位', async () => {
    const scope = await makeScope('syntax')
    await makeExt(scope, 'broken', manifest('broken'), `export function activate(ctx) {\n  this is not js\n}`)
    const { errors } = await scanExtensions(scope)
    expect(errors).toHaveLength(1)
    expect(errors[0].reason).toMatch(/扩展打包失败：.*index\.ts:2:\d+/)
  })

  it('缺入口文件：errors 可读', async () => {
    const scope = await makeScope('no-entry')
    await makeExt(scope, 'no-entry', manifest('no-entry'), null)
    const { errors } = await scanExtensions(scope)
    expect(errors).toHaveLength(1)
    expect(errors[0].reason).toMatch(/缺少入口文件/)
  })

  it('无 manifest.json 的目录静默跳过；目录不存在返回空', async () => {
    const scope = await makeScope('skip')
    await mkdir(join(scope, 'plain-dir'), { recursive: true })
    const { loaded, errors } = await scanExtensions(scope)
    expect(loaded).toEqual([])
    expect(errors).toEqual([])
    const empty = await scanExtensions(join(scope, 'not-exist-at-all'))
    expect(empty).toEqual({ loaded: [], errors: [] })
  })
})

describe('requires 协效应端到端（真 ComponentHost）', () => {
  it('manifest.requires 透传：ai.configured 不满足即停用，满足即激活', async () => {
    const scope = await makeScope('gated')
    await makeExt(
      scope,
      'gated',
      JSON.stringify({ id: 'gated', name: '门控扩展', capabilities: ['ai.tools'], requires: ['ai.configured'] })
    )
    const { loaded, errors } = await scanExtensions(scope)
    expect(errors).toEqual([])
    const gated = loaded.find((l) => l.manifest.id === 'gated')!

    const host = new ComponentHost()
    host.register(gated.component)
    expect(host.listComponents()[0].state).toBe('inactive')
    expect(host.getTools()).toEqual([])
    host.setCoEffect('ai.configured', true)
    expect(host.listComponents()[0].state).toBe('active')
    await waitFor('gated 工具注册', () => host.getTools().length > 0)
    expect(host.getTools().map((t) => t.name)).toEqual(['echo_tool'])
    host.setCoEffect('ai.configured', false)
    expect(host.listComponents()[0].state).toBe('inactive')
    expect(host.getTools()).toEqual([])
  })
})

describe('ensureDemoExtension', () => {
  it('写入示例扩展且可装载（dice_roll + ui.panel 面板，真实打包 + 沙箱执行）；已存在则不覆盖', async () => {
    const demoDir = await makeScope('demo')
    await ensureDemoExtension(demoDir)
    await ensureDemoExtension(demoDir) // 幂等
    const manifestRaw = JSON.parse(await readFile(join(demoDir, 'sandbox.demo', 'manifest.json'), 'utf8'))
    expect(manifestRaw.id).toBe('sandbox.demo')

    const { loaded, errors } = await scanExtensions(demoDir)
    expect(errors).toEqual([])
    expect(loaded).toHaveLength(1)

    const panels: unknown[] = []
    const registered: AiTool[] = []
    loaded[0].component.activate({
      componentId: 'sandbox.demo',
      capabilities: {
        'ai.tools': {
          registerTool: (tool) => {
            registered.push(tool)
            return () => undefined
          }
        },
        'ui.panel': {
          mountPanel: (schema) => {
            panels.push(schema)
            return () => panels.pop()
          }
        }
      }
    })
    await waitFor('dice_roll 注册', () => registered.length > 0)
    const dice = registered[0]
    const out = JSON.parse(await dice.handler({ sides: 20, count: 3 }))
    expect(out.rolls).toHaveLength(3)
    for (const r of out.rolls) {
      expect(r).toBeGreaterThanOrEqual(1)
      expect(r).toBeLessThanOrEqual(20)
    }
    expect(out.total).toBe(out.rolls.reduce((a: number, b: number) => a + b, 0))
    // ui.panel：activate 即挂载统计面板
    await waitFor('面板挂载', () => panels.length > 0)
    const schema = panels[0] as { title: string; items: Array<{ type: string }> }
    expect(schema.title).toBe('骰子统计')
    expect(schema.items.map((i) => i.type)).toEqual(['text', 'kv', 'button'])
  })

  it('demo 扩展经真实沙箱 invoke（createSandbox 端到端）', async () => {
    const demoDir = await makeScope('demo-e2e')
    await ensureDemoExtension(demoDir)
    const { loaded } = await scanExtensions(demoDir)
    const registered: AiTool[] = []
    loaded[0].component.activate({
      componentId: 'sandbox.demo',
      capabilities: {
        'ai.tools': {
          registerTool: (tool) => {
            registered.push(tool)
            return () => undefined
          }
        },
        'ui.panel': {
          mountPanel: () => () => undefined
        }
      }
    })
    await waitFor('dice_roll 注册', () => registered.length > 0)
    // AiTool.handler 内部走 createSandbox 的 invoke（真 QuickJS VM + asyncify 桥）
    const out = JSON.parse(await registered[0].handler({ sides: 6 }))
    expect(out.rolls).toHaveLength(1)
    expect(out.rolls[0]).toBeGreaterThanOrEqual(1)
    expect(out.rolls[0]).toBeLessThanOrEqual(6)
  })
})
