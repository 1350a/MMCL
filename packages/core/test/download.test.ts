import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { ChecksumMismatchError, assertSafeRemoteUrl, downloadFile, fileSha1, HttpError, verifyFile } from '../src'

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

  it('网络中断（terminated）自动重试后成功', async () => {
    const payload = randomBytes(256 * 1024)
    let broken = true
    const server = createServer((req, res) => {
      if (broken) {
        broken = false
        res.writeHead(200, { 'Content-Length': String(payload.length) })
        res.write(payload.subarray(0, 1024))
        setTimeout(() => res.destroy(), 30) // 声明全长但中途断开 → undici 'terminated'
        return
      }
      res.writeHead(200, { 'Content-Length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo

    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'file.bin')
    await downloadFile(`http://127.0.0.1:${port}/file.bin`, dest, { checksum: sha1(payload) })

    expect(await fs.readFile(dest)).toEqual(payload)
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

  it('空闲超时（无响应头/无 body 流动）中止本次尝试并自动重试成功', async () => {
    const payload = randomBytes(2048)
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      res.writeHead(200, { 'Content-Length': String(payload.length) })
      if (requests === 1) {
        // 第一次：头已发但 body 一直不来（坏连接卡死场景），等待看门狗中止
        return
      }
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo

    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'file.bin')
    await downloadFile(`http://127.0.0.1:${port}/file.bin`, dest, { idleTimeoutMs: 200, checksum: sha1(payload) })

    expect(requests).toBe(2) // 首次被看门狗中止后重试
    expect(await fs.readFile(dest)).toEqual(payload)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('body 中途停流：看门狗中止后保留 .part，重试续传拼接成功', async () => {
    const payload = randomBytes(4096)
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      const match = /^bytes=(\d+)-/.exec(req.headers.range ?? '')
      if (requests === 1) {
        // 第一次：发一小段后永久挂起（不 destroy，纯停流）
        res.writeHead(200, { 'Content-Length': String(payload.length) })
        res.write(payload.subarray(0, 64))
        return // 永不 end
      }
      if (match) {
        const start = Number(match[1])
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': String(payload.length - start)
        })
        res.end(payload.subarray(start))
        return
      }
      res.writeHead(200, { 'Content-Length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo

    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'file.bin')
    await downloadFile(`http://127.0.0.1:${port}/file.bin`, dest, { idleTimeoutMs: 200, checksum: sha1(payload) })

    expect(requests).toBe(2)
    expect(await fs.readFile(dest)).toEqual(payload)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('外部取消信号不被空闲看门狗吞掉', async () => {
    const fixture = await startFixture(1024)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const controller = new AbortController()
    const task = downloadFile(`${fixture.baseUrl}/file.bin`, join(dir, 'x.bin'), {
      idleTimeoutMs: 200,
      signal: controller.signal
    })
    controller.abort()
    await expect(task).rejects.toThrow()
  })

  it('assertSafeRemoteUrl：公网 http/https 放行，本机/私网/保留地址与非 http 协议拒绝', async () => {
    // 放行
    assertSafeRemoteUrl('https://cdn.modrinth.com/a/b/c.jar')
    assertSafeRemoteUrl('http://maven.fabricmc.net/org/x/1.0/x-1.0.jar')
    assertSafeRemoteUrl('https://bmclapi2.bangbang93.com/maven/x')
    // 额外信任 host（测试 fixture / 内网镜像口子）
    expect(() => assertSafeRemoteUrl('http://127.0.0.1:5000/x.jar', { allowHosts: ['127.0.0.1:5000'] })).not.toThrow()
    // 非法 URL / 协议
    expect(() => assertSafeRemoteUrl('not a url')).toThrow(/非法下载 URL/)
    expect(() => assertSafeRemoteUrl('ftp://example.com/x.jar')).toThrow(/仅允许 http\/https/)
    expect(() => assertSafeRemoteUrl('file:///etc/passwd')).toThrow(/仅允许 http\/https/)
    // 本机 / 私网 / 保留
    for (const bad of [
      'http://localhost/x.jar',
      'http://sub.localhost/x.jar',
      'http://127.0.0.1/x.jar',
      'http://0.1.2.3/x.jar',
      'http://10.1.2.3/x.jar',
      'http://172.16.0.1/x.jar',
      'http://172.31.255.255/x.jar',
      'http://192.168.1.1/x.jar',
      'http://169.254.9.9/x.jar',
      'http://100.64.0.1/x.jar',
      'http://198.18.0.1/x.jar',
      'http://224.0.0.1/x.jar',
      'http://240.0.0.1/x.jar',
      'http://[::1]/x.jar',
      'http://[fc00::1]/x.jar',
      'http://[fe80::1]/x.jar',
      'http://[ff02::1]/x.jar',
      'http://[::ffff:127.0.0.1]/x.jar'
    ]) {
      expect(() => assertSafeRemoteUrl(bad), bad).toThrow(/拒绝/)
    }
    // 172.15 / 172.32 / 100.63 不在私网段 → 放行
    expect(() => assertSafeRemoteUrl('http://172.15.0.1/x.jar')).not.toThrow()
    expect(() => assertSafeRemoteUrl('http://100.63.0.1/x.jar')).not.toThrow()
  })

  it('rename 被瞬态锁（EPERM）挡住时自动重试后成功（杀软扫描场景）', async () => {
    const fixture = await startFixture(256)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const dest = join(dir, 'locked.bin')

    const real = fs.rename.bind(fs)
    let renameCalls = 0
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      renameCalls++
      if (renameCalls <= 2) {
        const err = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return real(from, to)
    })
    try {
      await downloadFile(`${fixture.baseUrl}/file.bin`, dest, { checksum: sha1(fixture.payload) })
    } finally {
      spy.mockRestore()
    }

    expect(renameCalls).toBe(3)
    expect(await fs.readFile(dest)).toEqual(fixture.payload)
    expect(await exists(`${dest}.part`)).toBe(false)
  })

  it('rename 非瞬态错误（如 ENOENT）不重试直接抛出', async () => {
    const fixture = await startFixture(64)
    servers.push(fixture.server)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))

    const real = fs.rename.bind(fs)
    let renameCalls = 0
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      renameCalls++
      const err = new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })
    try {
      await expect(
        downloadFile(`${fixture.baseUrl}/file.bin`, join(dir, 'gone.bin'))
      ).rejects.toThrow(/ENOENT/)
    } finally {
      spy.mockRestore()
    }
    expect(renameCalls).toBe(1)
    void real
  })
})
