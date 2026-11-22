import type { CapabilityId } from '@mcl/host'
import { CAPABILITY_IDS } from '@mcl/host'
import type { ExtensionManifest } from './loader'

/**
 * 静态一致性检查（M5-5）：扩展源码实际访问的能力 vs manifest 声明的能力，双向比对。
 * 这是**辅助人工审核**的结构性检查，不是安全边界——安全边界 = 宿主只注入声明的能力，
 * 逃过扫描的动态键名在运行时拿到 undefined 自然失败（诚实边界，见 EXTENSION_API_DOC）。
 */

export interface ConsistencyResult {
  ok: boolean
  /** 源码用到但 manifest 未声明（宿主不会注入 → 运行时必然拿 undefined）。 */
  undeclared: string[]
  /** manifest 声明但源码未访问（声明了不用的能力应删掉，审核面最小化）。 */
  unused: CapabilityId[]
  /** 便于审核卡展示的中文一句话结论。 */
  summary: string
}

/**
 * 扫描源码中的能力访问形态：
 * - bracket：`capabilities['ui.panel']` / `capabilities["ai.tools"]`
 * - dot：`capabilities.foo`（点分能力 id 本身必须走 bracket——`capabilities.ai.tools`
 *   实际访问的是键 'ai'，运行时 undefined；扫描把首段捕获出来如实报 undeclared）
 * 要求以 `capabilities` 开头的标识符访问（`\b` 词边界），别名截取（`const caps = ...`）
 * 逃过扫描 → 被访问的能力计为 unused 而拒——宁可误拒不可漏放，文档约定直接访问。
 */
export function scanCapabilityUsage(code: string): string[] {
  const used = new Set<string>()
  const bracket = /\bcapabilities\s*\[\s*(['"])([^'"]+)\1\s*\]/g
  for (const m of code.matchAll(bracket)) used.add(m[2])
  const dot = /\bcapabilities\s*\.\s*([A-Za-z_$][\w$]*)/g
  for (const m of code.matchAll(dot)) used.add(m[1])
  return [...used]
}

/** 双向比对：用了未声明（undeclared）或声明未用（unused）都判不一致。 */
export function checkConsistency(manifest: Pick<ExtensionManifest, 'capabilities'>, code: string): ConsistencyResult {
  const declared = new Set<string>(manifest.capabilities)
  const used = scanCapabilityUsage(code)
  const undeclared = used.filter((u) => !declared.has(u)).sort()
  const unknown = undeclared.filter((u) => !CAPABILITY_IDS.includes(u as CapabilityId))
  const unused = manifest.capabilities.filter((c) => !used.includes(c)).sort()
  const ok = undeclared.length === 0 && unused.length === 0
  const parts: string[] = []
  if (undeclared.length > 0) {
    parts.push(
      `源码访问了未声明的能力：${undeclared.join('、')}` +
        (unknown.length > 0 ? `（其中 ${unknown.join('、')} 不是合法能力 id，能力 id 一律走 capabilities['X'] 方括号访问）` : '')
    )
  }
  if (unused.length > 0) parts.push(`声明了但源码未访问的能力：${unused.join('、')}（请从 manifest.capabilities 删除）`)
  return {
    ok,
    undeclared,
    unused,
    summary: ok ? '一致：源码访问与 manifest 声明完全吻合' : parts.join('；')
  }
}
