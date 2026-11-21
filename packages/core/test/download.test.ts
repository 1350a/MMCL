import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { ChecksumMismatchError, downloadFile, fileSha1, HttpError, verifyFile } from '../src'

interface Fixture {
  server: Server
  baseUrl: string
  payload: Buffer
  sawRange: () => boolean
}

/** 启动本地 HTTP 服务器：支持 Range 断点续传，/missing 返回 404。 */
async function startFixture(size: number): Promise<Fixture> {
  const payload = randomBytes(size)
  let ranged = false
  const server = createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404)
      res.end()
      return
    }
    const match = /^bytes=(\d+)-/.exec(req.headers.range ?? '')
    if (match) {
      ranged = true
      const start = Number(match[1])
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${size - 1}/${size}`,
        'Content-Length': String(size - start)
      })
      res.end(payload.subarray(start))
      return
    }
    res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': String(size) })
    res.end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, payload, sawRange: () => ranged }
}

const sha1 = (buf: Buffer | string): string => createHash('sha1').update(buf).digest('hex')
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(() => true).catch(() => false)

const servers: Server[] = []

afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

describe('verify', () => {
  it('verifyFile 通过/失败', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const p = join(dir, 'a.bin')
    await fs.writeFile(p, 'hello')
    await expect(verifyFile(p, sha1('hello'))).resolves.toBeUndefined()
    await expect(verifyFile(p, 'deadbeef')).rejects.toBeInstanceOf(ChecksumMismatchError)
  })
})

describe('downloadFile', () => {
  it('完整下载并通过 SHA1 校验，进度回调累计到总大小', async () => {
    const fixture = await startFixture(256 * 1024)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'file.bin')
    const progresses: number[] = []

    await downloadFile(`${fixture.baseUrl}/file.bin`, dest, {
      checksum: sha1(fixture.payload),
      onProgress: (downloaded) => progresses.push(downloaded)
    })

    expect(await fs.readFile(dest)).toEqual(fixture.payload)
    expect(await exists(`${dest}.part`)).toBe(false)
    expect(progresses.at(-1)).toBe(fixture.payload.length)
    expect(await fileSha1(dest)).toBe(sha1(fixture.payload))
  })

  it('断点续传：已有 .part 时使用 Range，最终文件完整且校验通过', async () => {
    const fixture = await startFixture(128 * 1024)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'file.bin')
    const half = fixture.payload.length >> 1
    await fs.writeFile(`${dest}.part`, fixture.payload.subarray(0, half))

    await downloadFile(`${fixture.baseUrl}/file.bin`, dest, { checksum: sha1(fixture.payload) })

    expect(fixture.sawRange()).toBe(true)
    expect(await fs.readFile(dest)).toEqual(fixture.payload)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('校验失败时抛出 ChecksumMismatchError 并清理 .part', async () => {
    const fixture = await startFixture(4096)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'file.bin')

    await expect(
      downloadFile(`${fixture.baseUrl}/file.bin`, dest, { checksum: '0'.repeat(40) })
    ).rejects.toBeInstanceOf(ChecksumMismatchError)

    expect(await exists(dest)).toBe(false)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('损坏的 .part 残留：续传拼接校验失败后自动全量重下自愈', async () => {
    const fixture = await startFixture(128 * 1024)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'file.bin')
    // 长度合理但内容错误的 .part（模拟上次异常中断留下的垃圾）
    await fs.writeFile(`${dest}.part`, randomBytes(64 * 1024))

    await downloadFile(`${fixture.baseUrl}/file.bin`, dest, { checksum: sha1(fixture.payload) })

    expect(fixture.sawRange()).toBe(true) // 先尝试了续传
    expect(await fs.readFile(dest)).toEqual(fixture.payload) // 自愈成功
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('404 抛出 HttpError', async () => {
    const fixture = await startFixture(128)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))

    await expect(
      downloadFile(`${fixture.baseUrl}/missing`, join(dir, 'x.bin'))
    ).rejects.toBeInstanceOf(HttpError)
  })
})
