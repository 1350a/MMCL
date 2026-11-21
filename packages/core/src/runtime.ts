import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:process'
import { describeFetchError, downloadFile } from './download'
import { extractZip } from './zip'
import { probeJava, type JavaInfo } from './java'

/** Adoptium API 资产查询地址（Temurin，GPLv2+Classpath Exception，可再分发）。 */
export const ADOPTIUM_ASSETS_URL = 'https://api.adoptium.net/v3/assets/latest'

/** 清华 TUNA 镜像（Adoptium 官方目录结构），官方源（GitHub releases）失败时回退。 */
export const TUNA_ADOPTIUM_URL = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium'

/** Microsoft Build of OpenJDK（MIT 许可）固定短链，仅 Windows；微软只发 JDK 无独立 JRE。 */
export const MS_JDK_URL_TEMPLATE = 'https://aka.ms/download-jdk/microsoft-jdk-{major}-windows-x64.zip'
export const MS_JDK_SHA_URL_TEMPLATE = 'https://aka.ms/download-jdk/microsoft-jdk-{major}-windows-x64.zip.sha256sum.txt'

/** 内置运行时根目录：<rootDir>/runtimes/java-<major>/，不写环境变量。 */
const RUNTIMES_DIR = 'runtimes'
const INSTALL_OK_MARKER = '.install-ok'
const JAVA_EXE = platform === 'win32' ? 'java.exe' : 'java'

export interface RuntimeInfo {
  major: number
  /** 该运行时的 java 可执行文件绝对路径。 */
  javaPath: string
}

export interface RuntimeProgress {
  phase: 'download' | 'extract'
  completed: number
  total: number
  file: string
}

export interface RuntimeInstallOptions {
  /** Adoptium API 地址（测试可指向本地 fixture）。 */
  apiBaseUrl?: string
  /** 镜像根地址（默认清华 TUNA），URL 模式 <mirror>/<major>/jre/x64/windows/<package.name>。 */
  mirrorBaseUrl?: string
  /** 微软 JDK 短链模板根（测试可指向本地 fixture），占位符 {major}。 */
  msJdkUrlTemplate?: string
  /** 微软 JDK sha256 文件模板根（测试用）。 */
  msJdkShaUrlTemplate?: string
  onProgress?: (p: RuntimeProgress) => void
  signal?: AbortSignal
  /** 解压后自检实现（默认真实执行 java -version；测试注入）。 */
  probe?: (javaPath: string) => Promise<JavaInfo>
}

/** 单个下载源。 */
interface RuntimeSource {
  label: string
  url: string
  sha256?: string
}

/** 微软 sha256sum.txt 格式：`<64位hex>  <文件名>`，取首行第一段。 */
async function fetchMsSha256(major: number, template: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(template.replace('{major}', String(major)), { signal })
    if (!res.ok) return undefined
    const text = await res.text()
    return /([a-f0-9]{64})/i.exec(text)?.[1]
  } catch {
    return undefined
  }
}

/**
 * 构建下载源列表（按优先级）：
 * Windows 上 Microsoft JDK（MIT，aka.ms 固定短链，直连可达）优先；
 * 其次 Adoptium/Temurin JRE（GitHub）与清华 TUNA 镜像。API 无 GA 时后两者跳过。
 */
async function resolveRuntimeSources(
  major: number,
  options: RuntimeInstallOptions,
  signal?: AbortSignal
): Promise<RuntimeSource[]> {
  const sources: RuntimeSource[] = []
  if (platform === 'win32') {
    const template = options.msJdkUrlTemplate ?? MS_JDK_URL_TEMPLATE
    const shaTemplate = options.msJdkShaUrlTemplate ?? MS_JDK_SHA_URL_TEMPLATE
    sources.push({
      label: 'Microsoft JDK',
      url: template.replace('{major}', String(major)),
      sha256: await fetchMsSha256(major, shaTemplate, signal)
    })
  }
  try {
    const pkg = await fetchRuntimePackage(options.apiBaseUrl ?? ADOPTIUM_ASSETS_URL, major, signal)
    sources.push({ label: 'Adoptium (Temurin JRE)', url: pkg.link, sha256: pkg.checksum })
    sources.push({
      label: '清华 TUNA 镜像',
      url: `${options.mirrorBaseUrl ?? TUNA_ADOPTIUM_URL}/${major}/jre/x64/windows/${pkg.name}`,
      sha256: pkg.checksum
    })
  } catch {
    // Adoptium 无 GA：跳过这两源，微软源仍可用
  }
  return sources
}

/** 解析 runtime 目录名 java-<major> → major，不合法返回 undefined。 */
function parseRuntimeDirName(name: string): number | undefined {
  const match = /^java-(\d+)$/.exec(name)
  return match ? Number(match[1]) : undefined
}

/** 列出已安装的内置运行时（带 .install-ok 标记的）。 */
export async function listInstalledRuntimes(rootDir: string): Promise<RuntimeInfo[]> {
  const dir = join(rootDir, RUNTIMES_DIR)
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: RuntimeInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const major = parseRuntimeDirName(e.name)
    if (major === undefined) continue
    const versionDir = join(dir, e.name)
    const marker = join(versionDir, INSTALL_OK_MARKER)
    const javaPath = join(versionDir, 'bin', JAVA_EXE)
    try {
      await fs.access(marker)
      await fs.access(javaPath)
      out.push({ major, javaPath })
    } catch {
      // 半成品（无标记或缺可执行文件），跳过
    }
  }
  return out.sort((a, b) => a.major - b.major)
}

interface AdoptiumAsset {
  version: { major: number }
  binary: {
    package: {
      name: string
      link: string
      size: number
      checksum: string
    }
  }
}

/** 从 Adoptium 资产列表取第一个 JRE 包；无 GA 时抛清晰错误。 */
async function fetchRuntimePackage(apiBaseUrl: string, major: number, signal?: AbortSignal) {
  const url = `${apiBaseUrl}/${major}/hotspot?os=windows&architecture=x64&image_type=jre`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`Adoptium API 请求失败: HTTP ${res.status} (${url})`)
  }
  const assets = (await res.json()) as AdoptiumAsset[]
  const asset = assets[0]
  if (!asset?.binary?.package?.link) {
    throw new Error(`Adoptium 无 Java ${major} 的 JRE GA 发布（image_type=jre 结果为空）`)
  }
  return asset.binary.package
}

/**
 * 安装内置 Java 运行时（Temurin JRE）到 <rootDir>/runtimes/java-<major>/。
 * 流程：Adoptium 查资产 → sha256 校验下载 → 解压 → 顶层目录提升 → java -version 自检 → 完成标记。
 * 不写任何环境变量。
 */
export async function installRuntime(
  rootDir: string,
  major: number,
  options: RuntimeInstallOptions = {}
): Promise<RuntimeInfo> {
  if (!Number.isInteger(major) || major < 8) {
    throw new Error(`invalid java major version: ${major}`)
  }
  const { onProgress, signal } = options
  const probe = options.probe ?? probeJava
  const runtimesRoot = join(rootDir, RUNTIMES_DIR)
  const targetDir = join(runtimesRoot, `java-${major}`)
  const stagingDir = `${targetDir}.staging`

  // 重装前清残留
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.rm(join(targetDir, INSTALL_OK_MARKER), { force: true })
  await fs.mkdir(stagingDir, { recursive: true })

  try {
    const sources = await resolveRuntimeSources(major, options, signal)
    if (sources.length === 0) {
      throw new Error(`Java ${major} 没有可用的下载源`)
    }
    const zipPath = join(stagingDir, `runtime-${major}.zip`)
    const failures: string[] = []
    let downloaded = false
    for (const source of sources) {
      onProgress?.({ phase: 'download', completed: 0, total: 1, file: source.label })
      try {
        await downloadFile(source.url, zipPath, {
          checksum: source.sha256,
          algorithm: 'sha256',
          signal
        })
        downloaded = true
        break
      } catch (err) {
        if (signal?.aborted) throw err
        failures.push(`${source.label}: ${describeFetchError(err)}`)
      }
    }
    if (!downloaded) {
      throw new Error(`下载 Java ${major} 运行时失败，所有源均不可用 — ${failures.join('；')}`)
    }

    // 解压到 staging，然后把唯一顶层目录内容提升为 targetDir
    const extractDir = join(stagingDir, 'extract')
    await extractZip(zipPath, extractDir, {
      onProgress: (done, total) => onProgress?.({ phase: 'extract', completed: done, total, file: `runtime-${major}.zip` })
    })
    const top = await fs.readdir(extractDir, { withFileTypes: true })
    const dirs = top.filter((d) => d.isDirectory)
    if (dirs.length !== 1) {
      throw new Error(`unexpected runtime zip layout: expected 1 top-level dir, got ${dirs.length}`)
    }
    await fs.rm(targetDir, { recursive: true, force: true })
    await fs.rename(join(extractDir, dirs[0].name), targetDir)

    // 自检：java -version 的 major 必须与目标一致
    const javaPath = join(targetDir, 'bin', JAVA_EXE)
    const info = await probe(javaPath)
    if (info.majorVersion !== major) {
      throw new Error(`runtime self-check failed: expected java ${major}, got ${info.majorVersion}`)
    }

    await fs.writeFile(join(targetDir, INSTALL_OK_MARKER), `${new Date().toISOString()}\n`)
    return { major, javaPath }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 在内置运行时中找 major >= required 的最小版本。 */
export function pickRuntime(runtimes: RuntimeInfo[], requiredMajor: number): RuntimeInfo | undefined {
  return runtimes
    .filter((r) => r.major >= requiredMajor)
    .sort((a, b) => a.major - b.major)[0]
}
