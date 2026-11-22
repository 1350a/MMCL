import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describeFetchError, downloadFile } from './download'

/**
 * authlib-injector jar 获取（AGPL-3.0+ with AUTHLIB-INJECTOR exception：
 * 分发未修改二进制 + Java Agent 加载被官方例外条款明确豁免，不传染本项目）。
 * 官方分发 API 见 wiki「获取 authlib-injector」；BMCLAPI 为国内镜像兜底。
 */

/** 官方版本元数据（GET /artifact/latest.json）。 */
export const AUTHLIB_INJECTOR_META_URL = 'https://authlib-injector.yushi.moe/artifact/latest.json'

/** BMCLAPI 镜像（同构 API，国内直连稳定）。 */
export const BMCLAPI_AUTHLIB_INJECTOR_META_URL =
  'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json'

const INJECTOR_DIR = 'authlib-injector'
const JAR_NAME = 'authlib-injector.jar'
/** 安装标记：JSON 内容 {buildNumber, version, sha256}，与 runtime 的 .install-ok 同风格。 */
const INSTALL_OK_MARKER = '.install-ok'

export interface AuthlibInjectorArtifact {
  build_number: number
  version: string
  download_url: string
  checksums?: { sha256?: string }
}

export interface AuthlibInjectorInfo {
  version: string
  buildNumber: number
  jarPath: string
}

export interface AuthlibInjectorInstallOptions {
  /** 版本元数据地址（测试可指向本地 fixture）；未装时逐源尝试。 */
  metaUrls?: string[]
  onProgress?: (downloaded: number, total: number | null) => void
  signal?: AbortSignal
}

interface InstallMarker {
  buildNumber: number
  version: string
  sha256: string
}

/** 解析版本元数据响应，字段不合法时抛错。 */
function parseArtifact(value: unknown, url: string): AuthlibInjectorArtifact {
  const v = value as Partial<AuthlibInjectorArtifact> | null
  if (
    v === null ||
    typeof v.build_number !== 'number' ||
    typeof v.version !== 'string' ||
    typeof v.download_url !== 'string' ||
    v.download_url === ''
  ) {
    throw new Error(`authlib-injector 版本元数据格式不正确: ${url}`)
  }
  return v as AuthlibInjectorArtifact
}

/** 从单个源拉版本元数据。 */
async function fetchArtifactFrom(metaUrl: string, signal?: AbortSignal): Promise<AuthlibInjectorArtifact> {
  const res = await fetch(metaUrl, { signal: signal ?? AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${metaUrl}`)
  return parseArtifact(await res.json(), metaUrl)
}

/** 已安装标记读取（无文件 / 解析失败返回 null）。 */
async function readMarker(markerPath: string): Promise<InstallMarker | null> {
  try {
    const raw = await fs.readFile(markerPath, 'utf8')
    const v = JSON.parse(raw) as Partial<InstallMarker> | null
    if (
      v === null ||
      typeof v.buildNumber !== 'number' ||
      typeof v.version !== 'string' ||
      typeof v.sha256 !== 'string'
    ) {
      return null
    }
    return v as InstallMarker
  } catch {
    return null
  }
}

/**
 * 确保 authlib-injector.jar 就绪：<rootDir>/authlib-injector/authlib-injector.jar。
 * jar + 标记已存在则直接跳过（不联网；升级通过删除目录触发重装）；
 * 未安装时逐源（官方 → BMCLAPI）取版本元数据并按 sha256 校验下载。
 */
export async function ensureAuthlibInjector(
  rootDir: string,
  options: AuthlibInjectorInstallOptions = {}
): Promise<AuthlibInjectorInfo> {
  const dir = join(rootDir, INJECTOR_DIR)
  const jarPath = join(dir, JAR_NAME)
  const markerPath = join(dir, INSTALL_OK_MARKER)

  const installed = await readMarker(markerPath)
  try {
    await fs.access(jarPath)
    if (installed) {
      return { version: installed.version, buildNumber: installed.buildNumber, jarPath }
    }
  } catch {
    // jar 缺失：标记视为半成品，走重装
  }

  const metaUrls = options.metaUrls ?? [AUTHLIB_INJECTOR_META_URL, BMCLAPI_AUTHLIB_INJECTOR_META_URL]
  const failures: string[] = []
  for (const metaUrl of metaUrls) {
    try {
      const artifact = await fetchArtifactFrom(metaUrl, options.signal)
      const sha256 = artifact.checksums?.sha256
      await downloadFile(artifact.download_url, jarPath, {
        checksum: sha256,
        algorithm: 'sha256',
        onProgress: options.onProgress,
        signal: options.signal
      })
      const marker: InstallMarker = {
        buildNumber: artifact.build_number,
        version: artifact.version,
        sha256: sha256 ?? ''
      }
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n')
      return { version: artifact.version, buildNumber: artifact.build_number, jarPath }
    } catch (err) {
      if (options.signal?.aborted) throw err
      failures.push(`${metaUrl}: ${describeFetchError(err)}`)
      await fs.rm(jarPath, { force: true }).catch(() => undefined)
    }
  }
  throw new Error(`下载 authlib-injector 失败，所有源均不可用 — ${failures.join('；')}`)
}
