import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { ChecksumMismatchError } from './errors'

export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512' | 'md5'

/** 流式计算文件哈希（十六进制小写）。默认 sha1，与 Mojang 版本清单一致。 */
export function hashFile(filePath: string, algorithm: HashAlgorithm = 'sha1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash: Hash = createHash(algorithm)
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 计算文件 SHA1。 */
export const fileSha1 = (filePath: string): Promise<string> => hashFile(filePath, 'sha1')

/** 校验文件哈希；不匹配时抛出 ChecksumMismatchError。 */
export async function verifyFile(
  filePath: string,
  expected: string,
  algorithm: HashAlgorithm = 'sha1'
): Promise<void> {
  const actual = await hashFile(filePath, algorithm)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new ChecksumMismatchError(filePath, expected, actual, algorithm)
  }
}
