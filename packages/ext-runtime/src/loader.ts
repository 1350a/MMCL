import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import * as esbuild from 'esbuild'
import type { BuildFailure } from 'esbuild'
import { CAPABILITY_IDS, isCoEffectExpr, isHostname, isInstanceId } from '@mcl/host'
import type { CapabilityId, CoEffectExpr, HostComponent } from '@mcl/host'
import { createSandboxComponent } from './component'
import { DEMO_EXTENSION_FILES } from './demoFiles'

/**
 * 扩展 manifest（<extensionsDir>/<dir>/manifest.json）。
 * id 必须与目录名一致：卸载按组件 id、来源可追溯。
 */
export interface ExtensionManifest {
  id: string
  name: string
  version?: string
  capabilities: CapabilityId[]
  requires?: CoEffectExpr[]
  /** fs.instance 作用域（声明 fs.instance 时必填）。 */
  fsInstances?: string[]
  /** net.domains 白名单（声明 net.domains 时必填）。 */
  netDomains?: string[]
}

export interface LoadedExtension {
  manifest: ExtensionManifest
  component: HostComponent
}

export interface ExtensionLoadError {
  dir: string
  reason: string
}

export interface ScanResult {
  loaded: LoadedExtension[]
  errors: ExtensionLoadError[]
}

/** manifest 结构校验 + 能力词汇表 / 协效应校验（错误信息面向扩展作者，中文可读）。 */
export function parseManifest(json: unknown, dirName: string): ExtensionManifest {
  if (typeof json !== 'object' || json === null) throw new Error('manifest.json 不是 JSON 对象')
  const m = json as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id.length === 0) throw new Error('manifest 缺少有效 id')
  if (m.id !== dirName) throw new Error(`manifest.id（${m.id}）与目录名（${dirName}）不一致`)
  if (typeof m.name !== 'string' || m.name.length === 0) throw new Error('manifest 缺少有效 name')
  if (m.version !== undefined && typeof m.version !== 'string') throw new Error('manifest.version 需为字符串')
  if (!Array.isArray(m.capabilities)) throw new Error('manifest.capabilities 需为数组')
  for (const cap of m.capabilities) {
    if (typeof cap !== 'string' || !CAPABILITY_IDS.includes(cap as CapabilityId)) {
      throw new Error(`manifest 声明了未知能力 ${String(cap)}（可用：${CAPABILITY_IDS.join('、')}）`)
    }
  }
  if (m.requires !== undefined) {
    if (!Array.isArray(m.requires)) throw new Error('manifest.requires 需为数组')
    for (const expr of m.requires) {
      if (!isCoEffectExpr(expr)) throw new Error(`manifest 声明了未知协效应 ${String(expr)}`)
    }
  }
  let fsInstances: string[] | undefined
  if (m.fsInstances !== undefined) {
    if (!Array.isArray(m.fsInstances) || !m.fsInstances.every((id) => isInstanceId(id))) {
      throw new Error('manifest.fsInstances 需为合法实例 id 数组')
    }
    fsInstances = m.fsInstances as string[]
  }
  let netDomains: string[] | undefined
  if (m.netDomains !== undefined) {
    if (!Array.isArray(m.netDomains) || !m.netDomains.every((d) => isHostname(d))) {
      throw new Error('manifest.netDomains 需为合法主机名数组')
    }
    netDomains = m.netDomains as string[]
  }
  return {
    id: m.id,
    name: m.name,
    ...(m.version === undefined ? {} : { version: m.version }),
    capabilities: m.capabilities as CapabilityId[],
    ...(m.requires === undefined ? {} : { requires: m.requires as CoEffectExpr[] }),
    ...(fsInstances ? { fsInstances } : {}),
    ...(netDomains ? { netDomains } : {})
  }
}

function describeBuildFailure(err: unknown): string {
  if (err && typeof err === 'object' && Array.isArray((err as BuildFailure).errors)) {
    return (err as BuildFailure).errors
      .map((m) =>
        m.location ? `${m.location.file}:${m.location.line}:${m.location.column + 1}: ${m.text}` : m.text
      )
      .join('；')
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * esbuild 内存打包：扩展入口 → IIFE（globalName 约定 __MCL_ENTRY__）。
 * platform neutral：不注入 process/Buffer，node 内建在打包期即被拒绝（bundle 解析失败）。
 */
export async function bundleExtension(entryFile: string): Promise<string> {
  try {
    const result = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__MCL_ENTRY__',
      platform: 'neutral',
      target: 'es2020',
      logLevel: 'silent'
    })
    const file = result.outputFiles[0]
    if (!file) throw new Error('esbuild 无输出')
    return file.text
  } catch (err) {
    throw new Error(`扩展打包失败：${describeBuildFailure(err)}`)
  }
}

/** bundleExtension 的 stdin 版：打包 AI 提交的源码字符串（不落盘，先试打包再入审核槽）。 */
export async function bundleSource(code: string): Promise<string> {
  try {
    const result = await esbuild.build({
      stdin: { contents: code, sourcefile: 'index.ts', resolveDir: '.', loader: 'ts' },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__MCL_ENTRY__',
      platform: 'neutral',
      target: 'es2020',
      logLevel: 'silent'
    })
    const file = result.outputFiles[0]
    if (!file) throw new Error('esbuild 无输出')
    return file.text
  } catch (err) {
    throw new Error(`扩展打包失败：${describeBuildFailure(err)}`)
  }
}

const ENTRY_CANDIDATES = ['index.ts', 'index.js']

const fileExists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

/** 装载单个扩展目录：manifest 校验 → 入口解析 → esbuild 打包 → 沙箱组件。 */
export async function loadExtensionFromDir(dir: string): Promise<LoadedExtension> {
  const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf8').catch(() => {
    throw new Error('缺少 manifest.json')
  })
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`manifest.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  const manifest = parseManifest(json, basename(dir))
  let entry: string | null = null
  for (const name of ENTRY_CANDIDATES) {
    const p = join(dir, name)
    if (await fileExists(p)) {
      entry = p
      break
    }
  }
  if (!entry) throw new Error('缺少入口文件（index.ts 或 index.js）')
  const code = await bundleExtension(entry)
  const component = createSandboxComponent({
    id: manifest.id,
    name: manifest.name,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    code,
    capabilities: manifest.capabilities,
    ...(manifest.requires ? { requires: manifest.requires } : {}),
    ...(manifest.fsInstances ? { fsInstances: manifest.fsInstances } : {}),
    ...(manifest.netDomains ? { netDomains: manifest.netDomains } : {})
  })
  return { manifest, component }
}

/**
 * 扫描扩展目录：每个子目录独立 try/catch（失败隔离，进 errors 不中断）；
 * 无 manifest.json 的目录视为非扩展，静默跳过。
 * 目录名即组件 id（parseManifest 强制），因此扫描结果天然无重复 id；
 * 跨来源注册到同一 ComponentHost 时由 host.register 兜底拒绝重复。
 */
export async function scanExtensions(extensionsDir: string): Promise<ScanResult> {
  const loaded: LoadedExtension[] = []
  const errors: ExtensionLoadError[] = []
  let entries
  try {
    entries = await fs.readdir(extensionsDir, { withFileTypes: true })
  } catch {
    return { loaded, errors } // 目录不存在 = 无扩展
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(extensionsDir, e.name)
    // 无 manifest.json 的目录视为非扩展：静默跳过
    if (!(await fileExists(join(dir, 'manifest.json')))) continue
    try {
      loaded.push(await loadExtensionFromDir(dir))
    } catch (err) {
      errors.push({ dir, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { loaded, errors }
}

/** 首次运行把示例扩展写入扩展目录；版本号与内置不同则自动升级（用户改过的请先改名备份）。 */
export async function ensureDemoExtension(extensionsDir: string): Promise<void> {
  const dir = join(extensionsDir, DEMO_EXTENSION_FILES.manifest.id)
  if (await fileExists(dir)) {
    try {
      const existing = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as { version?: string }
      if (existing.version === DEMO_EXTENSION_FILES.manifest.version) return
    } catch {
      // manifest 损坏：按升级处理
    }
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(DEMO_EXTENSION_FILES.manifest, null, 2))
  await fs.writeFile(join(dir, 'index.ts'), DEMO_EXTENSION_FILES.indexTs)
}
