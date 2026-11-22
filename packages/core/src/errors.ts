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

/** 玩家名不合法（3-16 位字母/数字/下划线）。 */
export class InvalidPlayerNameError extends Error {
  constructor(readonly name: string) {
    super(`invalid player name: ${name}`)
    this.name = 'InvalidPlayerNameError'
  }
}

/** 找不到可用的 Java 运行时。 */
export class JavaNotFoundError extends Error {
  constructor(readonly tried: string[]) {
    super(`java executable not found (tried: ${tried.join(', ')})`)
    this.name = 'JavaNotFoundError'
  }
}

/** Java 主版本与目标版本要求不符。 */
export class JavaVersionMismatchError extends Error {
  constructor(
    readonly majorVersion: number,
    readonly requiredMajorVersion: number
  ) {
    super(`java ${majorVersion} does not meet requirement: java ${requiredMajorVersion}`)
    this.name = 'JavaVersionMismatchError'
  }
}

/** Yggdrasil 认证服务器返回的业务错误（{error, errorMessage} 结构）。 */
export class YggdrasilError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly errorMessage: string | undefined,
    readonly url: string
  ) {
    super(`Yggdrasil ${error} (HTTP ${status})${errorMessage ? `: ${errorMessage}` : ''} [${url}]`)
    this.name = 'YggdrasilError'
  }
}
