import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { assertSafeRemoteUrl, fetchJsonWithRetry } from './download'
import { extractNatives, installVersion, BMCLAPI_MAVEN_BASE, mavenPath, nativesJarRelPath } from './install'
import { resolveInstalledVersion } from './installed'
import type { InstallProgress } from './install'
import type { Library, VersionJson } from './version'

/**
 * Fabric 加载器安装（fabric-meta v2 API，2026-11-22 逐字实测响应结构）：
 * 1. GET /versions/loader/<game>                        → loader 列表（含 launcherMeta）
 * 2. GET /versions/loader/<game>/<loader>/profile/json  → 启动器版本 JSON（inheritsFrom 指向原版）
 * profile 的 libraries 为旧式条目：asm/mixin 等自带 sha1/size，intermediary/fabric-loader 仅 name+url。
 * 统一转成 Library 格式：有 sha1 → downloads.artifact（校验下载）；无 → 旧式 url（沿用旧式不校验路径）。
 * 库下载主源 maven.fabricmc.net 在部分网络不可达（2026-11-22 桌面实测连接超时），挂 BMCLAPI maven 镜像回退。
 */
const FABRIC_META_BASE = 'https://meta.fabricmc.net/v2'

/** fabric-meta 的库条目（旧式 Maven 坐标 + 可选哈希）。 */
interface FabricMetaLibrary {
  name: string
  /** Maven 根 URL（带尾斜杠）。 */
  url?: string
  sha1?: string
  size?: number
}

interface FabricProfileResponse {
  id: string
  inheritsFrom: string
  releaseTime?: string
  time?: string
  type?: string
  mainClass: string
  arguments?: VersionJson['arguments']
  minecraftArguments?: string
  libraries?: FabricMetaLibrary[]
}

/** Fabric loader 版本信息（列表按 meta 返回顺序，新的在前）。 */
export interface FabricLoaderVersion {
  version: string
  stable: boolean
}

export interface FabricInstallOptions {
  onProgress?: (progress: InstallProgress) => void
  signal?: AbortSignal
  /** meta 基址（默认官方；测试指向本地 fixture）。 */
  metaBaseUrl?: string
  /** 单次 meta 请求超时（毫秒；默认 90s，测试可调短）。 */
  metaTimeoutMs?: number
  /** 库下载并发数，透传 installVersion。 */
  concurrency?: number
}

async function fetchJson<T>(url: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  // meta/profile 为幂等 GET：自带超时 + 重试（防校园网对 meta.fabricmc.net 的长时间挂死）
  return fetchJsonWithRetry<T>(url, {
    signal,
    headers: { Accept: 'application/json' },
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  })
}

/** 拉取可用于某游戏版本的 Fabric loader 列表。 */
export async function fetchFabricLoaderVersions(
  gameVersion: string,
  options: { signal?: AbortSignal; metaBaseUrl?: string; metaTimeoutMs?: number } = {}
): Promise<FabricLoaderVersion[]> {
  const base = (options.metaBaseUrl ?? FABRIC_META_BASE).replace(/\/+$/, '')
  const res = await fetchJson<Array<{ loader?: { version?: string; stable?: boolean } }>>(
    `${base}/versions/loader/${gameVersion}`,
    options.signal,
    options.metaTimeoutMs
  )
  if (!Array.isArray(res)) {
    throw new Error(`invalid fabric loader list for ${gameVersion}`)
  }
  return res
    .filter((e): e is { loader: { version: string; stable?: boolean } } => typeof e?.loader?.version === 'string')
    .map((e) => ({ version: e.loader.version, stable: e.loader.stable !== false }))
}

/** 把 profile 的库条目转成 VersionJson 的 Library：有 sha1 用 artifact（校验），无则旧式 url。 */
function toLibrary(lib: FabricMetaLibrary, metaHost: string): Library {
  if (typeof lib.name !== 'string') throw new Error('invalid fabric library entry')
  // lib.url 来自外部 meta 响应：仅允许 http/https 且不得指向本机/私网/保留地址（SSRF 防护）；
  // 与 meta 源同 host 的 URL（测试 fixture / 同源镜像）视为可信边界内放行
  if (lib.url !== undefined) assertSafeRemoteUrl(lib.url, { allowHosts: [metaHost] })
  if (lib.sha1 && !lib.url) {
    // 有哈希却没有 Maven 根，无法拼下载地址——装出去只会缺库，宁可在这里报出来
    throw new Error(`fabric library ${lib.name} 缺少 Maven 根 URL`)
  }
  if (lib.sha1 && lib.url) {
    const path = mavenPath(lib.name)
    return {
      name: lib.name,
      downloads: {
        artifact: {
          url: new URL(path, lib.url).toString(),
          path,
          sha1: lib.sha1,
          size: typeof lib.size === 'number' ? lib.size : 0
        }
      }
    }
  }
  return lib.url ? { name: lib.name, url: lib.url } : { name: lib.name }
}

/** 拉取并转换 Fabric 启动器版本 JSON（inheritsFrom 指向原版，安装后经继承链合并启动）。 */
export async function fetchFabricProfileJson(
  gameVersion: string,
  loaderVersion: string,
  options: { signal?: AbortSignal; metaBaseUrl?: string; metaTimeoutMs?: number } = {}
): Promise<VersionJson> {
  const base = (options.metaBaseUrl ?? FABRIC_META_BASE).replace(/\/+$/, '')
  const metaHost = new URL(base).host
  const profile = await fetchJson<FabricProfileResponse>(
    `${base}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`,
    options.signal,
    options.metaTimeoutMs
  )
  if (profile?.id === undefined || profile.inheritsFrom === undefined || typeof profile.mainClass !== 'string') {
    throw new Error(`invalid fabric profile for ${gameVersion}/${loaderVersion}`)
  }
  if (profile.inheritsFrom !== gameVersion) {
    // 与请求不符视为协议异常，避免装出链路混乱的版本
    throw new Error(`fabric profile inheritsFrom (${profile.inheritsFrom}) 与请求版本 (${gameVersion}) 不一致`)
  }
  return {
    id: profile.id,
    type: profile.type ?? 'release',
    mainClass: profile.mainClass,
    ...(profile.arguments ? { arguments: profile.arguments } : {}),
    ...(profile.minecraftArguments ? { minecraftArguments: profile.minecraftArguments } : {}),
    libraries: (profile.libraries ?? []).map((lib) => toLibrary(lib, metaHost)),
    ...(profile.releaseTime ? { releaseTime: profile.releaseTime } : {}),
    ...(profile.time ? { time: profile.time } : {}),
    inheritsFrom: profile.inheritsFrom
  }
}

/**
 * 安装 Fabric 加载器到 rootDir（versions/<fabric id>/ + loader 库）。
 * 前置：原版 <gameVersion> 已安装（json + client jar）。Fabric 版本自身无 client jar，
 * 启动时用父原版的；natives 也取父版本库，装完即从父版本已下载的 classifier jar 解压。
 */
export async function installFabric(
  rootDir: string,
  gameVersion: string,
  loaderVersion: string,
  options: FabricInstallOptions = {}
): Promise<{ versionId: string; versionDir: string }> {
  const parentJson = join(rootDir, 'versions', gameVersion, `${gameVersion}.json`)
  const parentJar = join(rootDir, 'versions', gameVersion, `${gameVersion}.jar`)
  for (const p of [parentJson, parentJar]) {
    try {
      await fs.access(p)
    } catch {
      throw new Error(`原版 ${gameVersion} 未安装：请先安装原版再装 Fabric 加载器`)
    }
  }
  const profile = await fetchFabricProfileJson(gameVersion, loaderVersion, options)
  await installVersion(profile, rootDir, {
    onProgress: options.onProgress,
    signal: options.signal,
    libraryAltBaseUrls: [BMCLAPI_MAVEN_BASE],
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {})
  })
  // 父原版的 natives 解压进 fabric 版本目录（父库文件此前已下载，纯本地操作）
  const osName =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const { json: parentResolved } = await resolveInstalledVersion(rootDir, gameVersion)
  const nativesDir = join(rootDir, 'versions', profile.id, 'natives')
  await fs.rm(nativesDir, { recursive: true, force: true })
  await fs.mkdir(nativesDir, { recursive: true })
  for (const lib of parentResolved.libraries ?? []) {
    const rel = nativesJarRelPath(lib, osName)
    if (!rel) continue
    const exclude = lib.extract?.exclude ?? ['META-INF/']
    await extractNatives(join(rootDir, 'libraries', rel), nativesDir, exclude)
  }
  return { versionId: profile.id, versionDir: join(rootDir, 'versions', profile.id) }
}
