import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { ensureAuthlibInjector } from '../src'

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

const JAR_CONTENT = 'fake-authlib-injector-jar'

/**
 * authlib-injector 分发 fixture：
 * /meta → 版本元数据（download_url 指向本地 /jar）；/jar → jar 内容。
 * jarBroken 时 /jar 404；tamperJar 时 /jar 返回与声明 sha256 不符的内容。
 */
async function startFixture(
  buildNumber = 42,
  jarBroken = false,
  tamperJar = false
): Promise<{ metaUrl: string; requests: string[] }> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/meta') {
      const { port } = server.address() as AddressInfo
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          build_number: buildNumber,
          version: `1.4.${buildNumber}`,
          download_url: `http://127.0.0.1:${port}/jar`,
          checksums: { sha256: sha256(JAR_CONTENT) }
        })
      )
      return
    }
    if (req.url === '/jar' && !jarBroken) {
      const body = tamperJar ? 'tampered-content' : JAR_CONTENT
      res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(body)) })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { metaUrl: `http://127.0.0.1:${port}/meta`, requests }
}

describe('ensureAuthlibInjector', () => {
  it('首装：取元数据 → sha256 校验下载 → 写标记，返回版本信息', async () => {
    const { metaUrl, requests } = await startFixture()
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-ai-'))
    const info = await ensureAuthlibInjector(dir, { metaUrls: [metaUrl] })

    expect(info.version).toBe('1.4.42')
    expect(info.buildNumber).toBe(42)
    expect(info.jarPath).toBe(join(dir, 'authlib-injector', 'authlib-injector.jar'))
    expect(await fs.readFile(info.jarPath, 'utf8')).toBe(JAR_CONTENT)
    const marker = JSON.parse(await fs.readFile(join(dir, 'authlib-injector', '.install-ok'), 'utf8'))
    expect(marker).toEqual({ buildNumber: 42, version: '1.4.42', sha256: sha256(JAR_CONTENT) })
    expect(requests).toEqual(['/meta', '/jar'])
  })

  it('已安装（jar + 标记齐全）时跳过，不发任何网络请求', async () => {
    const { metaUrl, requests } = await startFixture()
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-ai-'))
    await ensureAuthlibInjector(dir, { metaUrls: [metaUrl] })

    requests.length = 0
    const again = await ensureAuthlibInjector(dir, { metaUrls: [metaUrl] })
    expect(again.version).toBe('1.4.42')
    expect(requests).toEqual([])
  })

  it('jar 存在但标记缺失（半成品）→ 重装', async () => {
    const { metaUrl, requests } = await startFixture()
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-ai-'))
    await fs.mkdir(join(dir, 'authlib-injector'), { recursive: true })
    await fs.writeFile(join(dir, 'authlib-injector', 'authlib-injector.jar'), 'leftover')

    const info = await ensureAuthlibInjector(dir, { metaUrls: [metaUrl] })
    expect(await fs.readFile(info.jarPath, 'utf8')).toBe(JAR_CONTENT)
    expect(requests).toEqual(['/meta', '/jar'])
  })

  it('校验和不符的 jar 被拒绝，回退下一源', async () => {
    const evil = await startFixture(41, false, true) // sha256 与实际内容不符
    const good = await startFixture(43)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-ai-'))
    const info = await ensureAuthlibInjector(dir, { metaUrls: [evil.metaUrl, good.metaUrl] })

    expect(info.buildNumber).toBe(43)
    expect(await fs.readFile(info.jarPath, 'utf8')).toBe(JAR_CONTENT)
  })

  it('所有源均失败 → 聚合报错', async () => {
    const broken1 = await startFixture(1, true) // jar 404
    const broken2 = await startFixture(2, true)
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-ai-'))
    await expect(ensureAuthlibInjector(dir, { metaUrls: [broken1.metaUrl, broken2.metaUrl] })).rejects.toThrow(
      /所有源均不可用/
    )
    // 失败后不留下半成品 jar
    await expect(fs.access(join(dir, 'authlib-injector', 'authlib-injector.jar'))).rejects.toThrow()
  })
})
