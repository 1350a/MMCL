import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fetchFabricLoaderVersions, fetchFabricProfileJson, installFabric } from '../src'

const sha1 = (buf: Buffer | string): string => createHash('sha1').update(buf).digest('hex')

const servers: Server[] = []
afterAll(() => {
  // 不 await close：本沙箱下 keep-alive 空闲连接会让 close 回调延迟到 60s 超时；
  // fork 进程随测试结束退出，套接字由 OS 回收。closeAllConnections 立即断开所有连接。
  for (const s of servers) {
    s.closeAllConnections()
    s.close()
  }
})

async function makeRoot(): Promise<string> {
  const dir = join(tmpdir(), `mcl-fabric-test-${randomBytes(6).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

interface FabricFixtureOptions {
  /** 覆盖 profile 顶层字段（libraries 传函数以便拼 base URL）。 */
  profile?: Record<string, unknown> & { libraries?: (base: string) => Array<Record<string, unknown>> }
}

/** fabric-meta fixture：/versions/loader/<game> 列表 + profile/json + maven 库文件。 */
async function startFabricFixture(opts?: FabricFixtureOptions): Promise<string> {
  const asmPayload = Buffer.from('fake-asm-jar-content')
  const loaderPayload = Buffer.from('fake-loader-jar')
  let port = 0
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${port}`
    const profile = {
      id: 'fabric-loader-0.20.1-1.16.5',
      inheritsFrom: '1.16.5',
      releaseTime: '2025-01-01T00:00:00+00:00',
      time: '2025-01-01T00:00:00+00:00',
      type: 'release',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
      libraries: [
        {
          name: 'org.ow2.asm:asm:9.10.1',
          url: `${base}/maven/`,
          sha1: sha1(asmPayload),
          size: asmPayload.length
        },
        { name: 'net.fabricmc:fabric-loader:0.20.1', url: `${base}/maven/` }
      ],
      ...(opts?.profile?.libraries ? { libraries: opts.profile.libraries(base) } : {}),
      ...(() => {
        const { libraries: _l, ...rest } = opts?.profile ?? {}
        return rest
      })()
    }
    const url = req.url ?? ''
    const body = (payload: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url === '/versions/loader/1.16.5') {
      body([
        {
          loader: { separator: '.', build: 1, maven: 'net.fabricmc:fabric-loader:0.20.1', version: '0.20.1', stable: true },
          intermediary: { maven: 'net.fabricmc:intermediary:1.16.5', version: '1.16.5', stable: true },
          launcherMeta: { version: 2, min_java_version: 8, libraries: { client: [], common: [] }, mainClass: {} }
        },
        {
          loader: { maven: 'net.fabricmc:fabric-loader:0.20.0', version: '0.20.0', stable: false },
          intermediary: { maven: 'net.fabricmc:intermediary:1.16.5', version: '1.16.5', stable: true },
          launcherMeta: { version: 2, libraries: {}, mainClass: {} }
        }
      ])
      return
    }
    if (url === '/versions/loader/1.16.5/0.20.1/profile/json') {
      body(profile)
      return
    }
    if (url === '/maven/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar') {
      res.writeHead(200, { 'Content-Length': String(asmPayload.length) })
      res.end(asmPayload)
      return
    }
    if (url === '/maven/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar') {
      res.writeHead(200, { 'Content-Length': String(loaderPayload.length) })
      res.end(loaderPayload)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

describe('fetchFabricLoaderVersions', () => {
  it('解析 loader 列表（version + stable）', async () => {
    const base = await startFabricFixture()
    const versions = await fetchFabricLoaderVersions('1.16.5', { metaBaseUrl: base })
    expect(versions).toEqual([
      { version: '0.20.1', stable: true },
      { version: '0.20.0', stable: false }
    ])
  })

  it('meta 挂死时超时中止并自动重试成功', async () => {
    let requests = 0
    let port = 0
    const server = createServer((req, res) => {
      requests++
      if (requests === 1) {
        return // 第一次挂起不响应（坏连接卡死场景）
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          { loader: { maven: 'net.fabricmc:fabric-loader:0.20.1', version: '0.20.1', stable: true } }
        ])
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    port = (server.address() as AddressInfo).port

    const versions = await fetchFabricLoaderVersions('1.16.5', {
      metaBaseUrl: `http://127.0.0.1:${port}`,
      metaTimeoutMs: 300
    })
    expect(requests).toBe(2) // 首次超时中止后重试
    expect(versions).toEqual([{ version: '0.20.1', stable: true }])
  })
})

describe('fetchFabricProfileJson', () => {
  it('转换 profile：哈希库转 artifact（可校验），无哈希库保留旧式 url', async () => {
    const base = await startFabricFixture()
    const json = await fetchFabricProfileJson('1.16.5', '0.20.1', { metaBaseUrl: base })
    expect(json.id).toBe('fabric-loader-0.20.1-1.16.5')
    expect(json.inheritsFrom).toBe('1.16.5')
    expect(json.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(json.arguments?.jvm).toEqual(['-DFabricMcEmu= net.minecraft.client.main.Main '])
    expect(json.libraries).toHaveLength(2)
    const asm = json.libraries[0]
    expect(asm.downloads?.artifact?.path).toBe('org/ow2/asm/asm/9.10.1/asm-9.10.1.jar')
    expect(asm.downloads?.artifact?.url).toBe(`${base}/maven/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar`)
    expect(asm.downloads?.artifact?.sha1).toBe(sha1(Buffer.from('fake-asm-jar-content')))
    expect(asm.url).toBeUndefined()
    const loader = json.libraries[1]
    expect(loader.url).toBe(`${base}/maven/`)
    expect(loader.downloads).toBeUndefined()
  })

  it('inheritsFrom 与请求版本不一致时拒绝', async () => {
    const base = await startFabricFixture({ profile: { inheritsFrom: '1.16.4' } })
    await expect(fetchFabricProfileJson('1.16.5', '0.20.1', { metaBaseUrl: base })).rejects.toThrow(/不一致/)
  })

  it('缺 mainClass 的异常 profile 拒绝', async () => {
    const base = await startFabricFixture({ profile: { mainClass: undefined } })
    await expect(fetchFabricProfileJson('1.16.5', '0.20.1', { metaBaseUrl: base })).rejects.toThrow(/invalid fabric profile/)
  })
})

describe('installFabric', () => {
  async function installParent(root: string): Promise<void> {
    await fs.mkdir(join(root, 'versions', '1.16.5'), { recursive: true })
    await fs.writeFile(join(root, 'versions', '1.16.5', '1.16.5.json'), '{"id":"1.16.5"}')
    await fs.writeFile(join(root, 'versions', '1.16.5', '1.16.5.jar'), 'vanilla')
  }

  it('原版未安装时引导先装原版', async () => {
    const base = await startFabricFixture()
    const root = await makeRoot()
    await expect(installFabric(root, '1.16.5', '0.20.1', { metaBaseUrl: base })).rejects.toThrow(/请先安装原版/)
  })

  it('安装 fabric 版本：写 json + 完成标记，库按 sha1 校验下载', async () => {
    const base = await startFabricFixture()
    const root = await makeRoot()
    await installParent(root)
    const progressed: string[] = []
    const result = await installFabric(root, '1.16.5', '0.20.1', {
      metaBaseUrl: base,
      onProgress: (p) => progressed.push(p.file)
    })
    expect(result.versionId).toBe('fabric-loader-0.20.1-1.16.5')
    const versionDir = join(root, 'versions', 'fabric-loader-0.20.1-1.16.5')
    const stored = JSON.parse(await fs.readFile(join(versionDir, 'fabric-loader-0.20.1-1.16.5.json'), 'utf8')) as { id: string; libraries: Array<{ name: string }> }
    expect(stored.id).toBe('fabric-loader-0.20.1-1.16.5')
    expect(stored.libraries.map((l) => l.name)).toEqual(['org.ow2.asm:asm:9.10.1', 'net.fabricmc:fabric-loader:0.20.1'])
    await expect(fs.access(join(versionDir, '.install-ok'))).resolves.toBeUndefined()
    await expect(fs.access(join(versionDir, 'fabric-loader-0.20.1-1.16.5.jar'))).rejects.toThrow() // fabric 无 client jar
    const asm = await fs.readFile(join(root, 'libraries', 'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar'), 'utf8')
    expect(asm).toBe('fake-asm-jar-content')
    const loader = await fs.readFile(join(root, 'libraries', 'net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar'), 'utf8')
    expect(loader).toBe('fake-loader-jar')
    expect(progressed).toContain('asm-9.10.1.jar')
    expect(progressed).toContain('fabric-loader-0.20.1.jar')
  })

  it('库 sha1 校验失败时安装失败（runPool 聚合后文案含 checksum mismatch）', async () => {
    const bad = await startFabricFixture({
      profile: {
        id: 'fabric-loader-bad-1.16.5',
        libraries: (base) => [{ name: 'org.ow2.asm:asm:9.10.1', url: `${base}/maven/`, sha1: '0'.repeat(40), size: 1 }]
      }
    })
    const root = await makeRoot()
    await installParent(root)
    await expect(installFabric(root, '1.16.5', '0.20.1', { metaBaseUrl: bad })).rejects.toThrow(/checksum mismatch/)
  })
})
