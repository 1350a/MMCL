import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mergeVersionJson } from './manifest'
import type { VersionJson } from './version'

/** 继承链深度上限（防环）。 */
const MAX_INHERIT_DEPTH = 8

export interface InstalledVersionResolution {
  /** 沿 inheritsFrom 合并后的版本 JSON（inheritsFrom 已剥离，可直接交给 assembleLaunch）。 */
  json: VersionJson
  /** client jar 路径：继承链根版本的 jar（fabric 等 loader 子版本自身无 jar）。 */
  clientJarPath: string
}

async function readInstalledJson(rootDir: string, id: string): Promise<VersionJson> {
  const raw = await fs
    .readFile(join(rootDir, 'versions', id, `${id}.json`), 'utf8')
    .catch(() => {
      throw new Error(`版本 ${id} 未安装（缺少 versions/${id}/${id}.json）`)
    })
  try {
    return JSON.parse(raw) as VersionJson
  } catch {
    throw new Error(`版本 ${id} 的 JSON 损坏（无法解析）`)
  }
}

/**
 * 解析已安装版本的启动用 JSON：沿 inheritsFrom 逐级读取磁盘上的版本 JSON 并合并
 * （标量子优先、libraries/arguments 父子拼接），返回合并结果与继承链根版本的 client jar 路径。
 * 链上任一版本缺 JSON 或根版本缺 jar 都给出可读错误。
 */
export async function resolveInstalledVersion(rootDir: string, id: string): Promise<InstalledVersionResolution> {
  let chainId = id
  let chainJson = await readInstalledJson(rootDir, chainId)
  let accumulated = chainJson
  let rootId = chainId
  for (let depth = 0; chainJson.inheritsFrom; depth++) {
    if (depth >= MAX_INHERIT_DEPTH) {
      throw new Error(`版本 ${id} 的继承链过深（> ${MAX_INHERIT_DEPTH} 层），疑似成环`)
    }
    const parentId = chainJson.inheritsFrom
    const parentJson = await readInstalledJson(rootDir, parentId)
    accumulated = mergeVersionJson(accumulated, parentJson)
    rootId = parentId
    chainId = parentId
    chainJson = parentJson // 沿原始 JSON 的 inheritsFrom 走，合并结果不参与寻链
  }
  const { inheritsFrom: _dropped, ...merged } = accumulated
  const clientJarPath = join(rootDir, 'versions', rootId, `${rootId}.jar`)
  await fs.access(clientJarPath).catch(() => {
    throw new Error(`client jar 缺失：versions/${rootId}/${rootId}.jar（请先安装 ${rootId}）`)
  })
  return { json: merged, clientJarPath }
}
