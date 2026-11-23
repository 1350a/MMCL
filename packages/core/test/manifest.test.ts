import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  ChecksumMismatchError,
  DEFAULT_MANIFEST_URL,
  evaluateRules,
  fetchVersionJson,
  fetchVersionManifest,
  fetchVersionManifestWithFallback,
  findVersionEntry,
  HttpError,
  mergeVersionJson
} from '../src'
import type { Rule, VersionJson } from '../src'

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

/** 本地 JSON 服务器：路径 → 响应 JSON，/missing 返回 404。 */
async function startJsonFixture(routes: Record<string, unknown>): Promise<string> {
  const server = createServer((req, res) => {
    const body = routes[req.url ?? '']
    if (body === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

const sha1 = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex')

describe('fetchVersionManifest', () => {
  it('拉取并解析清单，findVersionEntry 按 id 查找', async () => {
    const manifest = {
      latest: { release: '1.16.5', snapshot: '20w46a' },
      versions: [
        { id: '1.16.5', type: 'release', url: 'http://x/1.16.5.json', time: 't', releaseTime: 'r', sha1: 'a'.repeat(40) },
        { id: '1.12.2', type: 'release', url: 'http://x/1.12.2.json', time: 't', releaseTime: 'r', sha1: 'b'.repeat(40) }
      ]
    }
    const base = await startJsonFixture({ '/mc/game/version_manifest_v2.json': manifest })
    const fetched = await fetchVersionManifest(`${base}/mc/game/version_manifest_v2.json`)
    expect(fetched.latest.release).toBe('1.16.5')
    expect(fetched.versions).toHaveLength(2)
    expect(findVersionEntry(fetched, '1.12.2')?.url).toBe('http://x/1.12.2.json')
    expect(findVersionEntry(fetched, 'nope')).toBeUndefined()
  })

  it('404 抛 HttpError', async () => {
    const base = await startJsonFixture({})
    await expect(fetchVersionManifest(`${base}/missing`)).rejects.toBeInstanceOf(HttpError)
  })
})

describe('fetchVersionManifestWithFallback（M6 BMCLAPI 兜底）', () => {
  const manifest = {
    latest: { release: '1.20.1', snapshot: 'snapshot' },
    versions: [{ id: '1.20.1', type: 'release', url: 'http://x/1.20.1.json', time: 't', releaseTime: 'r', sha1: 'a'.repeat(40) }]
  }

  it('官方源成功：直接返回，不走兜底', async () => {
    const base = await startJsonFixture({ '/official': manifest })
    const fetched = await fetchVersionManifestWithFallback(`${base}/official`, `${base}/mirror`)
    expect(fetched.latest.release).toBe('1.20.1')
  })

  it('官方源失败（劫持/不可达）：回退镜像源', async () => {
    const base = await startJsonFixture({ '/mirror': manifest }) // /official 路径不存在 → 404
    const fetched = await fetchVersionManifestWithFallback(`${base}/official`, `${base}/mirror`)
    expect(fetched.versions).toHaveLength(1)
  })

  it('两源都失败：抛官方源的原始错误（便于归因劫持 vs 镜像同样不可达）', async () => {
    const base = await startJsonFixture({})
    await expect(fetchVersionManifestWithFallback(`${base}/official`, `${base}/mirror`)).rejects.toBeInstanceOf(HttpError)
  })
})

describe('fetchVersionJson', () => {
  it('sha1 校验通过时返回解析结果', async () => {
    const json: VersionJson = { id: '1.16.5', type: 'release', mainClass: 'a.b.C', libraries: [] }
    const text = JSON.stringify(json)
    const base = await startJsonFixture({ '/1.16.5.json': json })
    const fetched = await fetchVersionJson(`${base}/1.16.5.json`, sha1(text))
    expect(fetched.id).toBe('1.16.5')
  })

  it('sha1 不匹配抛 ChecksumMismatchError', async () => {
    const json: VersionJson = { id: 'x', type: 'release', mainClass: 'C', libraries: [] }
    const base = await startJsonFixture({ '/x.json': json })
    await expect(fetchVersionJson(`${base}/x.json`, '0'.repeat(40))).rejects.toBeInstanceOf(
      ChecksumMismatchError
    )
  })

  it('非法 JSON 抛出错误', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.end('not json')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo
    await expect(fetchVersionJson(`http://127.0.0.1:${port}/bad.json`)).rejects.toThrow(/invalid version JSON/)
  })
})

describe('mergeVersionJson（inheritsFrom）', () => {
  const parent: VersionJson = {
    id: '1.16.5',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-Dparent=1'] },
    assetIndex: { id: '1.16', sha1: 'a', size: 1, totalSize: 2, url: 'http://a' },
    libraries: [
      { name: 'group:shared:1.0', downloads: { artifact: { sha1: 'old', size: 1, url: 'http://old' } } },
      { name: 'group:parent-only:1.0' }
    ]
  }
  const child: VersionJson = {
    id: '1.16.5-forge',
    type: 'release',
    mainClass: 'forge.Main',
    inheritsFrom: '1.16.5',
    arguments: { game: ['--tweakClass', 'f'], jvm: ['-Dchild=1'] },
    libraries: [{ name: 'group:shared:2.0' }, { name: 'group:child-only:1.0' }]
  }

  it('标量字段子优先，libraries 父子合并且子覆盖同名父', () => {
    const merged = mergeVersionJson(child, parent)
    expect(merged.id).toBe('1.16.5-forge')
    expect(merged.mainClass).toBe('forge.Main')
    expect(merged.assetIndex).toEqual(parent.assetIndex) // 子没有，用父
    expect(merged.libraries.map((l) => l.name)).toEqual([
      'group:shared:2.0',
      'group:child-only:1.0',
      'group:parent-only:1.0'
    ])
  })

  it('arguments 为父 + 子拼接，minecraftArguments 空格拼接', () => {
    const merged = mergeVersionJson(child, parent)
    expect(merged.arguments?.game).toEqual(['--username', '${auth_player_name}', '--tweakClass', 'f'])
    expect(merged.arguments?.jvm).toEqual(['-Dparent=1', '-Dchild=1'])

    const oldChild: VersionJson = { ...child, arguments: undefined, minecraftArguments: '--child' }
    const oldParent: VersionJson = { ...parent, arguments: undefined, minecraftArguments: '--parent' }
    expect(mergeVersionJson(oldChild, oldParent).minecraftArguments).toBe('--parent --child')
  })

  it('DEFAULT_MANIFEST_URL 为官方清单地址', () => {
    expect(DEFAULT_MANIFEST_URL).toContain('launchermeta.mojang.com')
    expect(DEFAULT_MANIFEST_URL).toContain('version_manifest_v2.json')
  })
})

describe('evaluateRules', () => {
  const winCtx = { os: { name: 'windows', version: '10.0', arch: 'x64' }, features: {} }

  it('无 rules 直接允许', () => {
    expect(evaluateRules(undefined, winCtx)).toBe(true)
    expect(evaluateRules([], winCtx)).toBe(true)
  })

  it('allow 匹配当前 os，不匹配的 os 被忽略', () => {
    expect(evaluateRules([{ action: 'allow', os: { name: 'windows' } }], winCtx)).toBe(true)
    expect(evaluateRules([{ action: 'allow', os: { name: 'osx' } }], winCtx)).toBe(false)
  })

  it('disallow 匹配则禁止', () => {
    const rules: Rule[] = [{ action: 'disallow', os: { name: 'windows' } }]
    const osxOnly: Rule[] = [{ action: 'disallow', os: { name: 'osx' } }]
    expect(evaluateRules(rules, winCtx)).toBe(false)
    // 有 rules 但无匹配 → 默认不允许（官方语义，osx-only 规则必须能排除其他平台）
    expect(evaluateRules(osxOnly, winCtx)).toBe(false)
  })

  it('真实数据模式：无条件 allow + disallow osx → 除 mac 外允许', () => {
    const rules: Rule[] = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }]
    expect(evaluateRules(rules, winCtx)).toBe(true)
    expect(
      evaluateRules(rules, { os: { name: 'osx', arch: 'x64' }, features: {} })
    ).toBe(false)
  })

  it('多条规则取最后一条匹配的动作', () => {
    const rules: Rule[] = [
      { action: 'allow', os: { name: 'windows' } },
      { action: 'disallow' } // 恒匹配，覆盖前者
    ]
    expect(evaluateRules(rules, winCtx)).toBe(false)
  })

  it('os.version 正则与 features 匹配', () => {
    expect(
      evaluateRules([{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], winCtx)
    ).toBe(true)
    expect(
      evaluateRules([{ action: 'allow', os: { name: 'windows', version: '^11\\.' } }], winCtx)
    ).toBe(false)
    expect(evaluateRules([{ action: 'allow', features: { is_demo_user: true } }], winCtx)).toBe(false)
    expect(
      evaluateRules([{ action: 'allow', features: { is_demo_user: true } }],
        { ...winCtx, features: { is_demo_user: true } })
    ).toBe(true)
  })
})
