import { describe, expect, it } from 'vitest'
import type { CapabilityId } from '@mcl/host'
import { checkConsistency, scanCapabilityUsage } from '../src'

const manifest = (capabilities: CapabilityId[]): { capabilities: CapabilityId[] } => ({ capabilities })

describe('scanCapabilityUsage', () => {
  it('bracket 形态：单引号/双引号均识别', () => {
    const code = `
      ctx.capabilities['ai.tools'].registerTool(tool)
      const p = ctx.capabilities["ui.panel"]
    `
    expect(scanCapabilityUsage(code).sort()).toEqual(['ai.tools', 'ui.panel'])
  })

  it('dot 形态：捕获首段（点分能力 id 无法走点号，如实报未声明）', () => {
    expect(scanCapabilityUsage('ctx.capabilities.ui.mountPanel()')).toEqual(['ui'])
  })

  it('词边界：capabilitiesX / myCapabilities 不误报', () => {
    const code = `
      const myCapabilities = { ui: 1 }
      capabilitiesX['ai.tools']
      obj.capabilities['ui.panel']
    `
    expect(scanCapabilityUsage(code)).toEqual(['ui.panel'])
  })

  it('动态键名逃过扫描（诚实边界：运行时拿 undefined 自然失败，靠文档约定）', () => {
    const code = `
      const key = 'ui.panel'
      ctx.capabilities[key].mountPanel()
    `
    expect(scanCapabilityUsage(code)).toEqual([])
  })
})

describe('checkConsistency', () => {
  it('一致：声明与访问完全吻合', () => {
    const r = checkConsistency(manifest(['ai.tools', 'ui.panel']), `
      ctx.capabilities['ai.tools'].registerTool(tool)
      ctx.capabilities['ui.panel'].mountPanel(schema, cb)
    `)
    expect(r.ok).toBe(true)
    expect(r.undeclared).toEqual([])
    expect(r.unused).toEqual([])
    expect(r.summary).toMatch(/一致/)
  })

  it('用了未声明 → undeclared（含非能力 id 的可读提示）', () => {
    const r = checkConsistency(manifest(['ai.tools']), `ctx.capabilities['ui.panel'].mountPanel()`)
    expect(r.ok).toBe(false)
    expect(r.undeclared).toEqual(['ui.panel'])
    expect(r.summary).toMatch(/未声明的能力：ui\.panel/)
  })

  it('声明未用 → unused（审核面最小化）', () => {
    const r = checkConsistency(manifest(['ai.tools', 'ui.panel']), `ctx.capabilities['ai.tools'].registerTool(tool)`)
    expect(r.ok).toBe(false)
    expect(r.unused).toEqual(['ui.panel'])
    expect(r.summary).toMatch(/声明了但源码未访问的能力：ui\.panel/)
  })

  it('非能力 id 的访问（含 dot 形态）提示走方括号', () => {
    const r = checkConsistency(manifest(['ai.tools']), `ctx.capabilities.ai.tools.registerTool(t)`)
    expect(r.ok).toBe(false)
    expect(r.undeclared).toEqual(['ai'])
    expect(r.summary).toMatch(/不是合法能力 id/)
  })

  it('别名截取逃过扫描 → 声明未用而拒（宁可误拒不可漏放，文档约定直接访问）', () => {
    const r = checkConsistency(manifest(['ai.tools']), `
      const caps = ctx.capabilities
      caps['ai.tools'].registerTool(tool)
    `)
    expect(r.ok).toBe(false)
    expect(r.undeclared).toEqual([])
    expect(r.unused).toEqual(['ai.tools'])
  })

  it('双向同时失败：undeclared 与 unused 并报', () => {
    const r = checkConsistency(manifest(['game.hooks']), `
      ctx.capabilities['ai.tools'].registerTool(tool)
    `)
    expect(r.ok).toBe(false)
    expect(r.undeclared).toEqual(['ai.tools'])
    expect(r.unused).toEqual(['game.hooks'])
  })
})
