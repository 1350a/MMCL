/** HTTP 请求失败（非 2xx / 非 206 / 416 重试后仍失败）。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    super(`HTTP ${status} from ${url}`)
    this.name = 'HttpError'
  }
}

/** 文件校验和不匹配。 */
export class ChecksumMismatchError extends Error {
  constructor(
    readonly filePath: string,
    readonly expected: string,
    readonly actual: string,
    readonly algorithm: string
  ) {
    super(`checksum mismatch for ${filePath}: expected ${expected}, got ${actual} (${algorithm})`)
    this.name = 'ChecksumMismatchError'
  }
}
