export const VERSION = '0.1.0'

export { downloadFile } from './download'
export type { DownloadOptions } from './download'

export { hashFile, fileSha1, verifyFile } from './verify'
export type { HashAlgorithm } from './verify'

export { ChecksumMismatchError, HttpError } from './errors'
