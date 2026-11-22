import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { MODRINTH_USER_AGENT, installModFile, listModVersions, searchMods } from '../src'

const sha1 = (buf: Buffer | string): string => createHash('sha1').update(buf).digest('hex')

const servers: Server[] = []
afterAll(() => {
  // 不 await close：本沙箱下 keep-alive 空闲连接会让 close 回调延迟到 60s 超时；
  // fork 进程随测试结束退出，套接字由 OS 回收。
  for (const s of servers) {
    s.closeAllConnections()
    s.close()
  }
})

async function makeDir(): Promise<string> {
  const dir = join(tmpdir(), `mcl-modrinth-test-${randomBytes(6).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

interface QueryCapture {
  query: URLSearchParams
  ua: string
}

/** Modrinth API fixture：/search、/project/<id>/version、/cdn/<file>。 */
async function startModrinthFixture(): Promise<{ base: string; captured: QueryCapture[] }> {
  const captured: QueryCapture[] = []
  const jarPayload = Buffer.from('fake-mod-jar-content')
  let port = 0
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${port}`
    captured.push({ query: new URL(req.url ?? '/', base).searchParams, ua: String(req.headers['user-agent'] ?? '') })
    const url = new URL(req.url ?? '/', base)
    const json = (payload: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/search') {
      json({
        total_hits: 1,
        hits: [
          {
            project_id: 'AANobbMI',
            slug: 'sodium',
            title: 'Sodium',
            description: 'A modern rendering engine',
            author: 'jellysquid3',
            downloads: 123456,
            project_type: 'mod'
          }
        ]
      })
      return
    }
    if (url.pathname === '/project/AANobbMI/version') {
      json([
        {
          id: 'v1',
          version_number: '0.2.0+1.16.5',
          date_published: '2021-05-01T00:00:00Z',
          game_versions: ['1.16.5'],
          loaders: ['fabric'],
          featured: true,
          files: [
            {
              url: `${base}/cdn/sodium-0.2.0.jar`,
              filename: 'sodium-0.2.0.jar',
              size: jarPayload.length,
              primary: true,
              hashes: { sha1: sha1(jarPayload) }
            }
          ]
        }
      ])
      return
    }
    if (url.pathname === '/cdn/sodium-0.2.0.jar') {
      res.writeHead(200, { 'Content-Length': String(jarPayload.length) })
      res.end(jarPayload)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, captured }
}

describe('searchMods', () => {
  it('搜索并映射字段，facets 含 project_type/versions/categories', async () => {
    const { base, captured } = await startModrinthFixture()
    const hits = await searchMods('sodium', {
      gameVersion: '1.16.5',
      loader: 'fabric',
      apiBaseUrl: base
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({
      projectId: 'AANobbMI',
      slug: 'sodium',
      title: 'Sodium',
      description: 'A modern rendering engine',
      author: 'jellysquid3',
      downloads: 123456
    })
    const facets = JSON.parse(captured[0].query.get('facets') ?? '[]') as string[][]
    expect(facets).toEqual([['project_type:mod'], ['versions:1.16.5'], ['categories:fabric']])
    expect(captured[0].query.get('query')).toBe('sodium')
    // UA 标识（Modrinth 公平限流规范）
    expect(captured[0].ua).toBe(MODRINTH_USER_AGENT)
    expect(MODRINTH_USER_AGENT).toContain('MMCL/')
  })
})

describe('listModVersions', () => {
  it('按游戏版本/加载器过滤并映射文件（url/filename/sha1/primary）', async () => {
    const { base, captured } = await startModrinthFixture()
    const versions = await listModVersions('AANobbMI', {
      gameVersion: '1.16.5',
      loader: 'fabric',
      apiBaseUrl: base
    })
    expect(versions).toHaveLength(1)
    const v = versions[0]
    expect(v.id).toBe('v1')
    expect(v.versionNumber).toBe('0.2.0+1.16.5')
    expect(v.gameVersions).toEqual(['1.16.5'])
    expect(v.loaders).toEqual(['fabric'])
    expect(v.files[0]).toEqual({
      url: `${base}/cdn/sodium-0.2.0.jar`,
      filename: 'sodium-0.2.0.jar',
      size: Buffer.from('fake-mod-jar-content').length,
      primary: true,
      sha1: sha1(Buffer.from('fake-mod-jar-content'))
    })
    expect(captured[0].query.get('game_versions')).toBe(JSON.stringify(['1.16.5']))
    expect(captured[0].query.get('loaders')).toBe(JSON.stringify(['fabric']))
  })
})

describe('installModFile', () => {
  it('下载主文件到 mods/ 并通过 sha1 校验', async () => {
    const { base } = await startModrinthFixture()
    const gameDir = await makeDir()
    const versions = await listModVersions('AANobbMI', { gameVersion: '1.16.5', loader: 'fabric', apiBaseUrl: base })
    const file = versions[0].files.find((f) => f.primary)!
    const dest = await installModFile(gameDir, file, { allowUrlHosts: [new URL(base).host] })
    expect(dest).toBe(join(gameDir, 'mods', 'sodium-0.2.0.jar'))
    const content = await fs.readFile(dest, 'utf8')
    expect(content).toBe('fake-mod-jar-content')
  })

  it('非 .jar 文件名拒绝', async () => {
    const gameDir = await makeDir()
    await expect(
      installModFile(gameDir, { url: 'http://x.example.com/f.txt', filename: 'f.txt', size: 1, primary: true, sha1: '' })
    ).rejects.toThrow(/非 \.jar/)
  })

  it('URL 指向本机/私网地址时拒绝（SSRF 防护）', async () => {
    const gameDir = await makeDir()
    for (const url of ['http://127.0.0.1/x.jar', 'http://localhost/x.jar', 'http://10.0.0.5/x.jar', 'http://192.168.1.2/x.jar']) {
      await expect(
        installModFile(gameDir, { url, filename: 'x.jar', size: 1, primary: true, sha1: '' })
      ).rejects.toThrow(/拒绝/)
    }
  })

  it('sha1 不匹配时报错且不落盘', async () => {
    const { base } = await startModrinthFixture()
    const gameDir = await makeDir()
    await expect(
      installModFile(gameDir, {
        url: `${base}/cdn/sodium-0.2.0.jar`,
        filename: 'sodium-0.2.0.jar',
        size: 1,
        primary: true,
        sha1: '0'.repeat(40)
      }, { allowUrlHosts: [new URL(base).host] })
    ).rejects.toThrow(/checksum mismatch/)
    const mods = await fs.readdir(join(gameDir, 'mods')).catch(() => [] as string[])
    expect(mods).toHaveLength(0) // 校验失败不落正式文件
  })
})
