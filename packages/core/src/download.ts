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
}

/** 网络类错误（可安全重试：.part 续传已下部分）。校验失败 / HTTP 状态错误 / 用户中断不在此列。 */
function isNetworkError(err: unknown): boolean {
  if (err instanceof ChecksumMismatchError || err instanceof HttpError) return false
  const message = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}` : String(err)
  return /terminated|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|ETIMEDOUT|network/i.test(message)
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
 * 网络类错误自动重试 2 次（间隔 1s/2s），已下部分经 .part 续传复用。
 */
export async function downloadFile(url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptDownload(url, dest, options)
    } catch (err) {
      if (attempt >= 2 || !isNetworkError(err) || options.signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

async function attemptDownload(
  url: string,
  dest: string,
  options: DownloadOptions = {},
  isRetry = false
): Promise<void> {
  const { checksum, algorithm = 'sha1', resume = true, onProgress, headers = {}, signal } = options
  const part = `${dest}.part`
  await fs.mkdir(dirname(dest), { recursive: true })

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

  const response = await fetch(url, { headers: requestHeaders, redirect: 'follow', signal })

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
    onProgress?.(downloaded, total)
  })

  // 中断（含 AbortError）时保留 .part，供下次续传
  await pipeline(body, fileStream)

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
