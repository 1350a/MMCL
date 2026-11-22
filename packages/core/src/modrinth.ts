import { join } from 'node:path'
import { VERSION } from './version-constants'
import { assertSafeRemoteUrl, downloadFile, fetchJsonWithRetry } from './download'

/**
 * Modrinth API v2 最小接入（M4；2026-11-22 逐字实测响应结构）：
 * 搜索 → 项目版本列表（按游戏版本/加载器过滤）→ 主文件下载（sha1 校验，落 mods/）。
 * 匿名请求可用（公平限流）；User-Agent 标识遵守 Modrinth 社区规范。
 */
const MODRINTH_API_BASE = 'https://api.modrinth.com/v2'

/** Modrinth 要求可识别的 User-Agent（公平限流按 UA 计）。 */
export const MODRINTH_USER_AGENT = `MMCL/${VERSION} (Minecraft Java third-party launcher)`

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  // 幂等 GET：自带超时 + 重试（防挂死）
  return fetchJsonWithRetry<T>(url, {
    signal,
    headers: { 'User-Agent': MODRINTH_USER_AGENT, Accept: 'application/json' }
  })
}

/** 搜索结果条目（只保留选择 mod 所需字段，避免污染 AI 工具上下文）。 */
export interface ModrinthSearchHit {
  projectId: string
  slug: string
  title: string
  description: string
  author?: string
  downloads?: number
}

export interface ModrinthSearchOptions {
  /** 按游戏版本过滤（facet versions:）。 */
  gameVersion?: string
  /** 按加载器过滤（facet categories:，如 fabric）。 */
  loader?: string
  /** 返回条数上限，默认 10（API 上限 100）。 */
  limit?: number
  signal?: AbortSignal
  /** API 基址（测试指向本地 fixture）。 */
  apiBaseUrl?: string
}

export async function searchMods(query: string, options: ModrinthSearchOptions = {}): Promise<ModrinthSearchHit[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100))
  const facets: string[][] = [['project_type:mod']]
  if (options.gameVersion) facets.push([`versions:${options.gameVersion}`])
  if (options.loader) facets.push([`categories:${options.loader}`])
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    facets: JSON.stringify(facets)
  })
  const base = (options.apiBaseUrl ?? MODRINTH_API_BASE).replace(/\/+$/, '')
  // 实测结构：{ total_hits, hits: [...] }
  const res = await fetchJson<{ total_hits?: number; hits?: Array<Record<string, unknown>> }>(
    `${base}/search?${params}`,
    options.signal
  )
  if (!Array.isArray(res?.hits)) {
    throw new Error('invalid modrinth search response')
  }
  return res.hits
    .filter((h): h is Record<string, unknown> => typeof h?.project_id === 'string')
    .map((h) => ({
      projectId: h.project_id as string,
      slug: typeof h.slug === 'string' ? h.slug : (h.project_id as string),
      title: typeof h.title === 'string' ? h.title : '',
      description: typeof h.description === 'string' ? h.description : '',
      ...(typeof h.author === 'string' && h.author ? { author: h.author } : {}),
      ...(typeof h.downloads === 'number' ? { downloads: h.downloads } : {})
    }))
}

/** Modrinth 版本的单个文件（primary = 官方推荐主文件）。 */
export interface ModrinthVersionFile {
  url: string
  filename: string
  size: number
  primary: boolean
  sha1: string
}

export interface ModrinthVersion {
  id: string
  versionNumber: string
  datePublished: string
  gameVersions: string[]
  loaders: string[]
  files: ModrinthVersionFile[]
}

export interface ModrinthVersionOptions {
  gameVersion?: string
  loader?: string
  signal?: AbortSignal
  apiBaseUrl?: string
}

export async function listModVersions(
  projectIdOrSlug: string,
  options: ModrinthVersionOptions = {}
): Promise<ModrinthVersion[]> {
  const base = (options.apiBaseUrl ?? MODRINTH_API_BASE).replace(/\/+$/, '')
  const params = new URLSearchParams()
  if (options.gameVersion) params.set('game_versions', JSON.stringify([options.gameVersion]))
  if (options.loader) params.set('loaders', JSON.stringify([options.loader]))
  const qs = params.toString()
  const res = await fetchJson<Array<Record<string, unknown>>>(
    `${base}/project/${projectIdOrSlug}/version${qs ? `?${qs}` : ''}`,
    options.signal
  )
  if (!Array.isArray(res)) {
    throw new Error('invalid modrinth version list')
  }
  return res.map((v) => ({
    id: typeof v.id === 'string' ? v.id : '',
    versionNumber: typeof v.version_number === 'string' ? v.version_number : '',
    datePublished: typeof v.date_published === 'string' ? v.date_published : '',
    gameVersions: Array.isArray(v.game_versions) ? (v.game_versions as string[]) : [],
    loaders: Array.isArray(v.loaders) ? (v.loaders as string[]) : [],
    files: Array.isArray(v.files)
      ? (v.files as Array<Record<string, unknown>>).flatMap((f) => {
          const url = f.url
          const filename = f.filename
          if (typeof url !== 'string' || typeof filename !== 'string') return []
          const hashes = f.hashes as Record<string, string> | undefined
          return [
            {
              url,
              filename,
              size: typeof f.size === 'number' ? f.size : 0,
              primary: f.primary === true,
              sha1: hashes?.sha1 ?? ''
            }
          ]
        })
      : []
  }))
}

export interface InstallModFileOptions {
  signal?: AbortSignal
  /** 下载进度（字节数）。 */
  onProgress?: (downloaded: number, total: number | null) => void
  /** 额外放行的下载 host（测试 fixture / 局域网镜像，精确匹配含端口）；默认拒绝本机/私网/保留地址。 */
  allowUrlHosts?: string[]
}

/** 下载 mod 文件到 <gameDir>/mods/<filename>（sha1 校验、.part 续传）。返回落盘路径。 */
export async function installModFile(
  gameDir: string,
  file: ModrinthVersionFile,
  options: InstallModFileOptions = {}
): Promise<string> {
  if (!file.filename.endsWith('.jar')) {
    throw new Error(`mod 文件名异常（非 .jar）：${file.filename}`)
  }
  // file.url 来自外部 API 响应：仅允许 http/https 且不得指向本机/私网/保留地址（SSRF 防护）
  assertSafeRemoteUrl(file.url, { ...(options.allowUrlHosts ? { allowHosts: options.allowUrlHosts } : {}) })
  const dest = join(gameDir, 'mods', file.filename)
  await downloadFile(file.url, dest, {
    checksum: file.sha1 || undefined,
    signal: options.signal,
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  })
  return dest
}
