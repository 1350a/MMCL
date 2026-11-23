import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isIsolationStrategy } from './isolation'
import type { IsolationStrategy } from './isolation'

/**
 * 游戏实例注册表（M6 多实例，DESIGN.md §5.7）。
 * 实例 = instances/<id>/instance.json（id = 目录名，同扩展约定）；
 * versions/assets/libraries 全局共享，实例只是绑定一个已安装版本的独立 gameDir。
 */

/** 实例 id 合法性（目录名形态，禁路径分隔符与 ..）。host 的 fs.instance 作用域校验复用同一规则。 */
export function isInstanceId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(id) &&
    !id.includes('..')
  )
}

export interface InstanceMeta {
  id: string
  name: string
  /** 实例绑定的已安装版本 id；未设置 = 待用户/AI 指定。 */
  versionId?: string
  /** 版本隔离（UI 术语「每版本策略」）：缺省 = 跟随全局。 */
  isolation?: IsolationStrategy | 'follow'
  createdAt?: string
}

export const DEFAULT_INSTANCE_ID = 'main'

const metaPath = (instanceDir: string): string => join(instanceDir, 'instance.json')

/** 校验并规范化 instance.json 内容（id 必须与目录名一致）。 */
function parseInstanceMeta(json: unknown, dirName: string): InstanceMeta {
  if (typeof json !== 'object' || json === null) throw new Error('instance.json 不是 JSON 对象')
  const m = json as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id !== dirName) {
    throw new Error(`instance.json 的 id（${String(m.id)}）与目录名（${dirName}）不一致`)
  }
  if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 64) {
    throw new Error('instance.json 缺少有效 name（1-64 字符）')
  }
  if (m.versionId !== undefined && (typeof m.versionId !== 'string' || m.versionId.length === 0)) {
    throw new Error('instance.json 的 versionId 需为非空字符串')
  }
  if (
    m.isolation !== undefined &&
    m.isolation !== 'follow' &&
    !isIsolationStrategy(m.isolation)
  ) {
    throw new Error('instance.json 的 isolation 需为 follow 或五档策略之一')
  }
  if (m.createdAt !== undefined && typeof m.createdAt !== 'string') {
    throw new Error('instance.json 的 createdAt 需为字符串')
  }
  return {
    id: m.id,
    name: m.name,
    ...(m.versionId === undefined ? {} : { versionId: m.versionId }),
    ...(m.isolation === undefined ? {} : { isolation: m.isolation as IsolationStrategy | 'follow' }),
    ...(m.createdAt === undefined ? {} : { createdAt: m.createdAt })
  }
}

async function writeInstanceMeta(instanceDir: string, meta: InstanceMeta): Promise<void> {
  await fs.writeFile(metaPath(instanceDir), JSON.stringify(meta, null, 2))
}

/**
 * 扫描实例目录：有 instance.json 的目录解析元数据；无 instance.json 的目录按旧数据
 * 合成 `{ id, name: 目录名 }`（M6 之前的单实例时期只有裸目录，不猜版本）；非目录跳过。
 * 目录不存在视为无实例（返回空，调用方 ensureDefaultInstance 兜底）。
 */
export async function listInstances(rootDir: string): Promise<InstanceMeta[]> {
  const instancesDir = join(rootDir, 'instances')
  let entries
  try {
    entries = await fs.readdir(instancesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const list: InstanceMeta[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      const raw = await fs.readFile(metaPath(join(instancesDir, e.name)), 'utf8')
      list.push(parseInstanceMeta(JSON.parse(raw), e.name))
    } catch (err) {
      if (err instanceof Error && err.name === 'SyntaxError') {
        throw new Error(`实例 ${e.name} 的 instance.json 损坏：${err.message}`)
      }
      // 无 instance.json（旧数据裸目录）或读取失败：合成最小元数据
      list.push({ id: e.name, name: e.name })
    }
  }
  // main 稳定排首，其余按 id
  return list.sort((a, b) => {
    if (a.id === DEFAULT_INSTANCE_ID) return -1
    if (b.id === DEFAULT_INSTANCE_ID) return 1
    return a.id.localeCompare(b.id)
  })
}

/** 读取单个实例（不存在或元数据损坏抛可读错误）。 */
export async function getInstance(rootDir: string, id: string): Promise<InstanceMeta> {
  if (!isInstanceId(id)) throw new Error(`非法实例 id：${String(id)}`)
  const instancesDir = join(rootDir, 'instances')
  const raw = await fs.readFile(metaPath(join(instancesDir, id)), 'utf8').catch(() => {
    throw new Error(`实例 ${id} 不存在（缺少 instances/${id}/instance.json）`)
  })
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`实例 ${id} 的 instance.json 损坏：${err instanceof Error ? err.message : String(err)}`)
  }
  return parseInstanceMeta(json, id)
}

/** 创建实例：id 校验 + 目录占用拒绝；落 instance.json（versionId 可空 = 待设置）。 */
export async function createInstance(
  rootDir: string,
  input: { id: string; name: string; versionId?: string }
): Promise<InstanceMeta> {
  if (!isInstanceId(input.id)) {
    throw new Error(`实例 id 非法（${String(input.id)}）：需为 1-64 位字母/数字/._- 组成的目录名形态`)
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 64) {
    throw new Error('实例 name 需为 1-64 字符')
  }
  if (input.versionId !== undefined && (typeof input.versionId !== 'string' || input.versionId.length === 0)) {
    throw new Error('versionId 需为非空字符串')
  }
  const instanceDir = join(rootDir, 'instances', input.id)
  const exists = await fs.access(instanceDir).then(() => true, () => false)
  if (exists) throw new Error(`实例 ${input.id} 已存在（目录占用）`)
  const meta: InstanceMeta = {
    id: input.id,
    name: input.name.trim(),
    ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    createdAt: new Date().toISOString()
  }
  await fs.mkdir(instanceDir, { recursive: true })
  await writeInstanceMeta(instanceDir, meta)
  return meta
}

/** 更新实例元数据（name / versionId 绑定 / 隔离策略）；未设置的键保持不变。 */
export async function updateInstance(
  rootDir: string,
  id: string,
  patch: { name?: string; versionId?: string; isolation?: IsolationStrategy | 'follow' }
): Promise<InstanceMeta> {
  const meta = await getInstance(rootDir, id)
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim().length === 0 || patch.name.length > 64) {
      throw new Error('实例 name 需为 1-64 字符')
    }
    meta.name = patch.name.trim()
  }
  if (patch.versionId !== undefined) {
    if (typeof patch.versionId !== 'string' || patch.versionId.length === 0) {
      throw new Error('versionId 需为非空字符串')
    }
    meta.versionId = patch.versionId
  }
  if (patch.isolation !== undefined) {
    if (patch.isolation !== 'follow' && !isIsolationStrategy(patch.isolation)) {
      throw new Error('isolation 需为 follow 或五档策略之一')
    }
    meta.isolation = patch.isolation
  }
  await writeInstanceMeta(join(rootDir, 'instances', id), meta)
  return meta
}

/**
 * 删除实例：整个实例目录不可逆删除。隔离开启时该目录即数据目录（mods/存档/设置）；
 * 隔离关闭时数据在根 .minecraft（不受影响），目录内只有元数据。
 * 危险操作——调用方负责确认（UI 确认弹窗；游戏运行中的守卫在 launcher 层）。
 */
export async function deleteInstance(rootDir: string, id: string): Promise<void> {
  if (!isInstanceId(id)) throw new Error(`非法实例 id：${String(id)}`)
  await getInstance(rootDir, id) // 不存在即抛可读错误
  await fs.rm(join(rootDir, 'instances', id), { recursive: true, force: false })
}

/**
 * 删除版本本体（versions/<id>/ 的 jar + 清单 + 标记），UI-DESIGN.md §3：
 * 无任何版本引用时自动清理（设置可调）。调用方负责引用计数与开关判断。
 */
export async function deleteVersionArtifacts(rootDir: string, versionId: string): Promise<void> {
  if (!isInstanceId(versionId)) throw new Error(`非法版本 id：${String(versionId)}`)
  await fs.rm(join(rootDir, 'versions', versionId), { recursive: true, force: true })
}

/**
 * 确保默认实例存在（启动器每次运行调用）：无 instances 目录或 main 缺失 → 创建 main；
 * main 目录存在但无 instance.json（旧数据）→ 补写元数据（name 主实例，版本待设置）；
 * 已有元数据 → no-op。其他实例不受影响。
 */
export async function ensureDefaultInstance(rootDir: string): Promise<InstanceMeta> {
  const instancesDir = join(rootDir, 'instances')
  const dirExists = await fs.access(instancesDir).then(() => true, () => false)
  if (!dirExists) {
    return createInstance(rootDir, { id: DEFAULT_INSTANCE_ID, name: '主实例' })
  }
  const metaFileExists = await fs
    .access(metaPath(join(instancesDir, DEFAULT_INSTANCE_ID)))
    .then(() => true, () => false)
  if (metaFileExists) {
    return getInstance(rootDir, DEFAULT_INSTANCE_ID)
  }
  const mainDirExists = await fs
    .access(join(instancesDir, DEFAULT_INSTANCE_ID))
    .then(() => true, () => false)
  const meta: InstanceMeta = {
    id: DEFAULT_INSTANCE_ID,
    name: '主实例',
    createdAt: new Date().toISOString()
  }
  if (!mainDirExists) await fs.mkdir(join(instancesDir, DEFAULT_INSTANCE_ID), { recursive: true })
  await writeInstanceMeta(join(instancesDir, DEFAULT_INSTANCE_ID), meta)
  return meta
}
