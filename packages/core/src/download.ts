import { createWriteStream, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { HttpError } from './errors'
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

/**
 * 下载文件到 dest，支持断点续传与校验和。
 * 文件先写入 dest.part，校验通过后才 rename 为 dest，保证 dest 永远是完整文件。
 */
export async function downloadFile(
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
    return downloadFile(url, dest, options, true)
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
      throw error
    }
  }

  await fs.rename(part, dest)
}
