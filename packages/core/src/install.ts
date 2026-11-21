import AdmZip from 'adm-zip'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { downloadFile } from './download'
import { verifyFile } from './verify'
import { evaluateRules, type RuleContext } from './rules'
import { extractZip } from './zip'
import type { Library, VersionJson } from './version'

/** 资源对象下载域名（URL 模式：<前2位hex>/<sha1>）。 */
const ASSETS_BASE_URL = 'https://resources.download.minecraft.net'

/** 版本安装完成标记（写于 versions/<id>/ 下，供"已安装"列表过滤半成品）。 */
const INSTALL_OK_MARKER = '.install-ok'

/** 单个文件下载任务。 */
interface DownloadTask {
  url: string
  dest: string
  sha1: string
  label: string
  /** 期望大小（fastSkip 用）。 */
  size?: number
  /** 已存在文件与该 size 一致时直接跳过（用于 assets objects：hash 即文件名，全量 sha1 太慢）。 */
  fastSkip?: boolean
}

export interface InstallProgress {
  /** 已完成任务数。 */
  completed: number
  /** 任务总数（去重后）。 */
  total: number
  /** 刚完成的文件描述。 */
  file: string
}

export interface InstallOptions {
  /** 目标平台，默认按 process.platform 推断。 */
  os?: { name: 'windows' | 'osx' | 'linux'; arch?: string }
  /** 下载并发数，默认 8。 */
  concurrency?: number
  /** 资源对象下载域名（URL 模式：<前2位hex>/<sha1>），默认官方。 */
  assetBaseUrl?: string
  /** 跳过 assets objects 下载（仅装 client/libraries/natives 的冒烟场景）。 */
  skipAssets?: boolean
  onProgress?: (progress: InstallProgress) => void
  signal?: AbortSignal
}

export interface InstallResult {
  versionDir: string
  clientJar: string
  nativesDir: string
  assetsIndexId: string
  /** log4j 配置文件路径与参数模板（logging.client），无 logging 字段时为 undefined。 */
  logging?: { argument: string; file: string }
}

/** Maven 坐标 group:artifact:version[:classifier] → Maven 布局相对路径。 */
export function mavenPath(name: string, classifier?: string): string {
  const [group, artifact, version, extra] = name.split(':')
  if (!group || !artifact || !version) {
    throw new Error(`invalid maven coordinate: ${name}`)
  }
  const suffix = (classifier ?? extra) ? `-${classifier ?? extra}` : ''
  const ext = (classifier ?? extra) === 'aar' ? '.aar' : '.jar'
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${suffix}${ext}`
}

/** 平台名 → natives classifier 后缀。 */
function nativesKey(osName: string): string {
  return `natives-${osName}`
}

/** 下载单个文件：已存在且校验通过则跳过，否则复用 downloadFile（.part 续传 + SHA1）。 */
async function downloadTask(task: DownloadTask, signal?: AbortSignal): Promise<void> {
  if (task.fastSkip && task.sha1) {
    try {
      const st = await fs.stat(task.dest)
      if (st.size === task.size) return // hash 即文件名，size 一致即视为完好
    } catch {
      // 文件不存在 → 走下载
    }
  }
  if (task.sha1 && !task.fastSkip) {
    try {
      await verifyFile(task.dest, task.sha1)
      return
    } catch {
      // 文件不存在或校验失败 → 重新下载
    }
  }
  await downloadFile(task.url, task.dest, { checksum: task.sha1 || undefined, signal })
}

/** 固定并发数的任务池：一个失败后停止派发新任务，结束时聚合报错。 */
async function runPool(
  tasks: DownloadTask[],
  concurrency: number,
  onProgress: ((p: InstallProgress) => void) | undefined,
  signal?: AbortSignal
): Promise<void> {
  let index = 0
  let completed = 0
  const errors: unknown[] = []
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (index < tasks.length) {
      if (signal?.aborted) throw new Error('aborted')
      if (errors.length > 0) return // 已有失败，不再派发新任务
      const task = tasks[index++]
      try {
        await downloadTask(task, signal)
      } catch (err) {
        errors.push(err)
        continue
      }
      completed++
      onProgress?.({ completed, total: tasks.length, file: task.label })
    }
  })
  await Promise.all(workers)
  if (errors.length > 0) {
    const first = errors[0] instanceof Error ? errors[0].message : String(errors[0])
    const more = errors.length > 1 ? `（另 ${errors.length - 1} 个文件同样失败）` : ''
    throw new Error(`${first} — 共 ${errors.length} 个文件失败`)
  }
}

/** 评估 library 是否适用于当前平台（rules 过滤）。 */
function libraryApplies(lib: Library, ctx: RuleContext): boolean {
  return evaluateRules(lib.rules, ctx)
}

/** 收集 library 的下载任务（artifact + 当前平台 natives classifier）。 */
function collectLibraryTasks(lib: Library, ctx: RuleContext, rootDir: string): DownloadTask[] {
  const tasks: DownloadTask[] = []
  const artifact = lib.downloads?.artifact
  if (artifact?.path) {
    tasks.push({
      url: artifact.url,
      dest: join(rootDir, 'libraries', artifact.path),
      sha1: artifact.sha1,
      label: basename(artifact.path)
    })
  } else if (lib.url) {
    // 旧式 library：url + Maven 布局拼接
    const path = mavenPath(lib.name)
    tasks.push({
      url: new URL(path, lib.url).toString(),
      dest: join(rootDir, 'libraries', path),
      sha1: '', // 旧式无 sha1，由调用方置空跳过校验
      label: basename(path)
    })
  }
  const classifier = lib.downloads?.classifiers?.[nativesKey(ctx.os.name)]
  if (classifier?.path) {
    tasks.push({
      url: classifier.url,
      dest: join(rootDir, 'libraries', classifier.path),
      sha1: classifier.sha1,
      label: basename(classifier.path)
    })
  } else if (lib.natives) {
    // 旧式 natives：按平台取 classifier 拼 Maven 布局
    const cls = lib.natives[nativesKey(ctx.os.name)]
    if (cls) {
      const path = mavenPath(lib.name, cls)
      tasks.push({
        url: new URL(path, lib.url ?? 'https://libraries.minecraft.net/').toString(),
        dest: join(rootDir, 'libraries', path),
        sha1: '',
        label: basename(path)
      })
    }
  }
  return tasks
}

/** 解压单个 natives jar 到目标目录（排除 META-INF 与 extract.exclude）。目录清理由调用方负责。 */
export async function extractNatives(nativesJarPath: string, destDir: string, exclude: string[]): Promise<void> {
  await extractZip(nativesJarPath, destDir, { exclude })
}

/** 安装一个版本：client jar、libraries（含 natives 解压）、assets。返回启动装配所需路径。 */
export async function installVersion(
  versionJson: VersionJson,
  rootDir: string,
  options: InstallOptions = {}
): Promise<InstallResult> {
  const osName = options.os?.name ?? (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux')
  const ctx: RuleContext = {
    os: { name: osName, arch: options.os?.arch ?? process.arch },
    features: {}
  }
  const concurrency = options.concurrency ?? 8
  const id = versionJson.id
  const versionDir = join(rootDir, 'versions', id)

  await fs.mkdir(versionDir, { recursive: true })
  await fs.writeFile(join(versionDir, `${id}.json`), JSON.stringify(versionJson, null, 2))
  // 重装前先清完成标记：中断后不会带着旧标记混进"已安装"列表
  await fs.rm(join(versionDir, INSTALL_OK_MARKER), { force: true })

  const tasks: DownloadTask[] = []

  // client jar
  const client = versionJson.downloads?.client
  if (client) {
    tasks.push({
      url: client.url,
      dest: join(versionDir, `${id}.jar`),
      sha1: client.sha1,
      label: `${id}.jar`
    })
  }

  // libraries（rules 过滤）
  const applied = versionJson.libraries.filter((lib) => libraryApplies(lib, ctx))
  for (const lib of applied) {
    tasks.push(...collectLibraryTasks(lib, ctx, rootDir))
  }

  // assets index
  const assetIndex = versionJson.assetIndex
  let assetsIndexId = versionJson.assets ?? ''
  if (assetIndex) {
    assetsIndexId = assetIndex.id
    tasks.push({
      url: assetIndex.url,
      dest: join(rootDir, 'assets', 'indexes', `${assetIndex.id}.json`),
      sha1: assetIndex.sha1,
      label: `asset-index-${assetIndex.id}.json`
    })
  }

  // logging 配置
  const loggingClient = versionJson.logging?.client
  let logging: InstallResult['logging']
  if (loggingClient) {
    const file = loggingClient.file
    const path = file.path ?? `log_configs/${file.id}`
    const loggingDest = join(rootDir, 'assets', ...path.split('/'))
    tasks.push({
      url: file.url,
      dest: loggingDest,
      sha1: file.sha1,
      label: file.id
    })
    logging = { argument: loggingClient.argument, file: loggingDest }
  }

  await runPool(tasks, concurrency, options.onProgress, options.signal)

  // assets objects：index 下载完成后按 hash 去重收集
  if (assetIndex && !options.skipAssets) {
    const indexRaw = await fs.readFile(join(rootDir, 'assets', 'indexes', `${assetIndex.id}.json`), 'utf8')
    const index = JSON.parse(indexRaw) as { objects: Record<string, { hash: string; size: number }> }
    const objects = new Map<string, { hash: string; size: number }>()
    for (const obj of Object.values(index.objects)) {
      objects.set(obj.hash, obj)
    }
    const objectTasks: DownloadTask[] = []
    const assetBase = options.assetBaseUrl ?? ASSETS_BASE_URL
    for (const hash of objects.keys()) {
      const prefix = hash.slice(0, 2)
      objectTasks.push({
        url: `${assetBase}/${prefix}/${hash}`,
        dest: join(rootDir, 'assets', 'objects', prefix, hash),
        sha1: hash,
        size: objects.get(hash)!.size,
        fastSkip: true,
        label: `asset-${hash.slice(0, 8)}`
      })
    }
    await runPool(objectTasks, concurrency, options.onProgress, options.signal)
  }

  // natives 解压
  const nativesDir = join(versionDir, 'natives')
  await fs.rm(nativesDir, { recursive: true, force: true })
  await fs.mkdir(nativesDir, { recursive: true })
  for (const lib of applied) {
    const classifier = lib.downloads?.classifiers?.[nativesKey(ctx.os.name)]
    let jarPath: string | undefined
    let exclude = lib.extract?.exclude ?? ['META-INF/']
    if (classifier?.path) {
      jarPath = join(rootDir, 'libraries', classifier.path)
    } else if (lib.natives) {
      const cls = lib.natives[nativesKey(ctx.os.name)]
      if (cls) jarPath = join(rootDir, 'libraries', mavenPath(lib.name, cls))
    }
    if (jarPath) {
      await extractNatives(jarPath, nativesDir, exclude)
    }
  }

  const clientJar = join(versionDir, `${id}.jar`)
  await fs.writeFile(join(versionDir, INSTALL_OK_MARKER), `${new Date().toISOString()}\n`)
  return {
    versionDir,
    clientJar,
    nativesDir,
    assetsIndexId,
    logging
  }
}
