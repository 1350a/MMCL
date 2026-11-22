import { createWriteStream, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { ChecksumMismatchError, HttpError } from './errors'
import { verifyFile, type HashAlgorithm } from './verify'

export interface DownloadOptions {
  /** 期望校验和（十六进制字符串）；提供则下载完成后校验，失败会删除 .part */
  checksum?: string
  /** 校验算法，默认 sha1（Mojang 版本清单使用 SHA1） */
  algorithm?: HashAlgorithm
  /** 断点续传（默认开启）：中间文件为 dest + ".part"，完成后 rename 为 dest */
  resume?: boolean
  /** 进度回调：已下载字节数、总字节数（未知为 null） */
  onProgress?: (downloaded: number, total: number | null) => void
  /** 附加请求头 */
  headers?: Record<string, string>
  /** 中断信号 */
  signal?: AbortSignal
  /**
   * 下载空闲超时（毫秒）：这么久没有任何数据流动（含等待响应头）则中止本次尝试，
   * 按网络错误处理（触发重试/换源，.part 保留续传）。默认 30s；0 = 关闭。
   * 背景：undici 默认 bodyTimeout/headersTimeout 为 300s，坏连接要挂满 5 分钟。
   */
  idleTimeoutMs?: number
  /** 网络类错误的重试次数（默认 2；多源回退场景下非末位源传 0 以尽快换源）。 */
  retries?: number
}

/** 网络类错误（可安全重试：.part 续传已下部分）。校验失败 / HTTP 状态错误 / 用户中断不在此列。 */
function isNetworkError(err: unknown): boolean {
  if (err instanceof ChecksumMismatchError || err instanceof HttpError) return false
  const message = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}` : String(err)
  return /terminated|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|ETIMEDOUT|timeout|network|空闲超时/i.test(message)
}

/** Windows 瞬态文件锁（杀软实时扫描刚写完的文件时 rename 会 EPERM/EBUSY）。 */
const RENAME_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** rename 遇瞬态文件锁自动重试（扫描通常几百毫秒内结束）。 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= 4 || !RENAME_LOCK_CODES.has(code)) throw err
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
    }
  }
}

/** 把底层 fetch 错误翻译成用户能看懂的一句话（含证书劫持识别）。 */
export function describeFetchError(err: unknown): string {
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? ''
  if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return '证书校验失败（当前网络可能存在劫持或需要代理）'
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * 下载文件到 dest，支持断点续传与校验和。
 * 文件先写入 dest.part，校验通过后才 rename 为 dest，保证 dest 永远是完整文件。
 * 网络类错误自动重试（默认 2 次，间隔 1s/2s），已下部分经 .part 续传复用。
 */
export async function downloadFile(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  const maxRetries = options.retries ?? 2
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptDownload(url, dest, options)
    } catch (err) {
      if (attempt >= maxRetries || !isNetworkError(err) || options.signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

/** 空闲看门狗触发 abort 时携带的标记 reason（区别于外部取消）。 */
const IDLE_ABORT_REASON = new Error('download-idle-timeout')

const IDLE_TIMEOUT_DEFAULT = 30_000

async function attemptDownload(
  url: string,
  dest: string,
  options: DownloadOptions = {},
  isRetry = false
): Promise<void> {
  const { checksum, algorithm = 'sha1', resume = true, onProgress, headers = {}, signal } = options
  const part = `${dest}.part`
  await fs.mkdir(dirname(dest), { recursive: true })

  // 空闲看门狗：自带 signal（不与外部取消 signal 混用判定——M3 教训），中止按网络错误重试
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_DEFAULT
  const idleSeconds = Math.round(idleMs / 1000)
  const idleController = new AbortController()
  const requestSignal = signal ? AbortSignal.any([signal, idleController.signal]) : idleController.signal
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    if (idleMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => idleController.abort(IDLE_ABORT_REASON), idleMs)
  }

  let downloaded = 0
  if (resume) {
    try {
      downloaded = (await fs.stat(part)).size
    } catch {
      downloaded = 0
    }
  }

  const requestHeaders: Record<string, string> = { ...headers }
  if (downloaded > 0) requestHeaders.Range = `bytes=${downloaded}-`

  try {
    armIdle()
    const response = await fetch(url, { headers: requestHeaders, redirect: 'follow', signal: requestSignal })

    // 416：部分文件比资源还大或服务器拒绝该 Range → 删掉重来一次
    if (response.status === 416) {
      if (isRetry) throw new HttpError(416, url)
      await fs.rm(part, { force: true })
      return attemptDownload(url, dest, options, true)
    }
    if (!response.ok && response.status !== 206) {
      throw new HttpError(response.status, url)
    }
    if (response.body === null) {
      throw new Error(`empty response body: ${url}`)
    }

    armIdle() // 响应头已到，重新计时 body 空闲
    const contentLength = Number(response.headers.get('content-length'))
    const knownLength = Number.isNaN(contentLength) ? 0 : contentLength
    const total =
      response.status === 206
        ? downloaded + knownLength
        : Number.isNaN(contentLength)
          ? null
          : contentLength

    // 服务器忽略 Range、从头返回 200：丢弃已有部分重新下载
    if (response.status === 200 && downloaded > 0) {
      await fs.rm(part, { force: true })
      downloaded = 0
    }

    const fileStream = createWriteStream(part, { flags: response.status === 206 ? 'a' : 'w' })
    const body = Readable.fromWeb(response.body as unknown as WebReadableStream)
    body.on('data', (chunk: Buffer) => {
      downloaded += chunk.length
      armIdle() // 有数据流动即喂狗
      onProgress?.(downloaded, total)
    })

    // 中断（含 AbortError）时保留 .part，供下次续传
    await pipeline(body, fileStream)
  } catch (err) {
    // 空闲超时的 abort 转成可读、可重试的网络错误；外部取消（signal 已 aborted）原样抛
    if (signal?.aborted) throw err
    if (idleController.signal.aborted && idleController.signal.reason === IDLE_ABORT_REASON) {
      throw new Error(`下载空闲超时：${idleSeconds}s 无数据流动，已中止本次尝试`)
    }
    throw err
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }

  if (checksum !== undefined) {
    try {
      await verifyFile(part, checksum, algorithm)
    } catch (error) {
      await fs.rm(part, { force: true }).catch(() => undefined)
      // .part 前缀与服务器内容不一致（如上次异常中断留下的损坏 .part）→ 全量重下一次自愈
      if (!isRetry) {
        return attemptDownload(url, dest, options, true)
      }
      throw error
    }
  }

  await renameWithRetry(part, dest)
}

/**
 * 幂等 GET 的 JSON fetch：每次尝试自带总时长超时（默认 90s，防 undici 默认 300s 挂死），
 * 网络类失败自动重试（默认 1 次；HTTP 非 2xx 视为业务响应不重试）。
 * 超时 signal 由本函数自带，与外部取消 signal 分离传递（M3 教训）。
 */
export async function fetchJsonWithRetry<T>(
  url: string,
  options: {
    signal?: AbortSignal
    /** 单次尝试总时长（毫秒），默认 90s。 */
    timeoutMs?: number
    /** 网络类失败的重试次数，默认 1。 */
    retries?: number
    headers?: Record<string, string>
  } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 90_000
  const retries = options.retries ?? 1
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: options.headers,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        throw new HttpError(res.status, url)
      }
      const text = await res.text()
      try {
        return JSON.parse(text) as T
      } catch (err) {
        throw new Error(`invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`)
      }
    } catch (err) {
      lastError = err
      // HTTP 状态错误是明确业务响应，不重试；外部取消不重试
      if (err instanceof HttpError || options.signal?.aborted) throw err
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000))
    }
  }
  // 重试耗尽：超时转可读中文（TimeoutError 原始信息对用户无意义）
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  if (/abort|timeout|timed?\s*out/i.test(message)) {
    const seconds = Math.round(timeoutMs / 1000)
    throw new Error(`连接超时（${seconds}s 内未完成响应，已重试 ${retries} 次）：${url}`)
  }
  throw lastError instanceof Error ? lastError : new Error(message)
}

/** IPv4 是否落在私有/保留段（环回、内网、链路本地、CGNAT、TEST-NET、组播等）。 */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (!m) return false
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF 协议 / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // 组播 + 保留
  return false
}

/**
 * 校验来自外部响应（fabric meta / Modrinth API 等）的下载 URL：
 * 仅允许 http/https，host 拒绝 localhost、环回、私有和保留地址（SSRF 防护）。
 * allowHosts 用于额外信任的 host（测试 fixture / 未来内网镜像），精确匹配 URL host（含端口）。
 */
export function assertSafeRemoteUrl(rawUrl: string, options: { allowHosts?: string[] } = {}): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`非法下载 URL：${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`下载 URL 仅允许 http/https：${rawUrl}`)
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (options.allowHosts?.includes(parsed.host.toLowerCase())) return
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`下载 URL 指向本机地址，已拒绝：${rawUrl}`)
  }
  if (isPrivateIPv4(host)) {
    throw new Error(`下载 URL 指向私有/保留地址，已拒绝：${rawUrl}`)
  }
  if (host.includes(':')) {
    // IPv6
    if (host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host)) {
      throw new Error(`下载 URL 指向私有/保留 IPv6 地址，已拒绝：${rawUrl}`)
    }
    // IPv4-mapped（URL 解析会把 ::ffff:127.0.0.1 规范成十六进制形式 ::ffff:7f00:1）
    const mapped = /^::ffff:(.+)$/.exec(host)
    if (mapped) {
      const tail = mapped[1]
      if (isPrivateIPv4(tail)) {
        throw new Error(`下载 URL 指向私有/保留地址（IPv4 映射），已拒绝：${rawUrl}`)
      }
      const hexGroups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
      if (hexGroups) {
        const hi = parseInt(hexGroups[1], 16)
        const lo = parseInt(hexGroups[2], 16)
        if (isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)) {
          throw new Error(`下载 URL 指向私有/保留地址（IPv4 映射），已拒绝：${rawUrl}`)
        }
      }
    }
  }
}
