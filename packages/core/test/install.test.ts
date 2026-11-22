import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { AddressInfo } from 'node:net'
import { installVersion, mavenPath } from '../src'
import type { VersionJson } from '../src'

const sha1 = (buf: Buffer | string): string => createHash('sha1').update(buf).digest('hex')

interface Fixture {
  server: Server
  baseUrl: string
  /** 各路径请求计数（断言 skip / 去重用）。 */
  counts: Map<string, number>
}

/** 本地下载服务器：路径 → 内容，记录请求次数。 */
async function startFixture(routes: Record<string, Buffer | string>): Promise<Fixture> {
  const counts = new Map<string, number>()
  const server = createServer((req, res) => {
    counts.set(req.url ?? '', (counts.get(req.url ?? '') ?? 0) + 1)
    const body = routes[req.url ?? '']
    if (body === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Length': String(body.length) })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}`, counts }
}

/** 打一个 natives jar：含 native.dll、META-INF/MANIFEST.MF、other.txt。 */
function makeNativeJar(): Buffer {
  const zip = new AdmZip()
  zip.addFile('native.dll', Buffer.from('fake-dll-content'))
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0'))
  zip.addFile('other.txt', Buffer.from('keep me'))
  return zip.toBuffer()
}

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

describe('mavenPath', () => {
  it('坐标转 Maven 布局路径，支持 classifier', () => {
    expect(mavenPath('org.lwjgl:lwjgl:3.2.2')).toBe('org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2.jar')
    expect(mavenPath('g:a:1.0', 'natives-windows')).toBe('g/a/1.0/a-1.0-natives-windows.jar')
    expect(mavenPath('g:a:1.0:natives-windows')).toBe('g/a/1.0/a-1.0-natives-windows.jar')
    expect(() => mavenPath('bad')).toThrow(/invalid maven coordinate/)
  })
})

describe('installVersion', () => {
  it('下载 client jar、libraries（rules 过滤）、natives 解压、assets 去重', async () => {
    const clientPayload = randomBytes(4096)
    const libPayload = randomBytes(1024)
    const nativeJar = makeNativeJar()
    const excludedLibPayload = randomBytes(128)
    const assetA = Buffer.from('asset-content-a')
    const xmlPayload = Buffer.from('<Configuration/>')

    // asset index：两个名字指向同一 hash，验证去重
    const indexJson = {
      objects: {
        'a.txt': { hash: sha1(assetA), size: assetA.length },
        'b.txt': { hash: sha1(assetA), size: assetA.length }
      }
    }
    const indexText = JSON.stringify(indexJson)
    const assetPrefix = sha1(assetA).slice(0, 2)

    const fixture = await startFixture({
      '/client.jar': clientPayload,
      '/lib-a.jar': libPayload,
      '/lib-osx.jar': excludedLibPayload,
      '/natives.jar': nativeJar,
      '/index.json': indexText,
      [`/${assetPrefix}/${sha1(assetA)}`]: assetA,
      '/client-test.xml': xmlPayload
    })
    servers.push(fixture.server)

    const versionJson: VersionJson = {
      id: 'test-1.0',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      downloads: {
        client: { sha1: sha1(clientPayload), size: clientPayload.length, url: `${fixture.baseUrl}/client.jar` }
      },
      assetIndex: {
        id: 'test-index',
        sha1: sha1(indexText),
        size: indexText.length,
        totalSize: assetA.length,
        url: `${fixture.baseUrl}/index.json`
      },
      assets: 'test-index',
      javaVersion: { component: 'jre-legacy', majorVersion: 8 },
      libraries: [
        {
          name: 'g:a:1.0',
          downloads: {
            artifact: { path: 'g/a/1.0/a-1.0.jar', sha1: sha1(libPayload), size: libPayload.length, url: `${fixture.baseUrl}/lib-a.jar` }
          }
        },
        {
          name: 'g:osx:1.0',
          rules: [{ action: 'allow', os: { name: 'osx' } }],
          downloads: {
            artifact: { path: 'g/osx/1.0/osx-1.0.jar', sha1: sha1(excludedLibPayload), size: excludedLibPayload.length, url: `${fixture.baseUrl}/lib-osx.jar` }
          }
        },
        {
          name: 'g:native:1.0',
          downloads: {
            artifact: { path: 'g/native/1.0/native-1.0.jar', sha1: sha1(libPayload), size: libPayload.length, url: `${fixture.baseUrl}/lib-a.jar` },
            classifiers: {
              'natives-windows': {
                path: 'g/native/1.0/native-1.0-natives-windows.jar',
                sha1: sha1(nativeJar),
                size: nativeJar.length,
                url: `${fixture.baseUrl}/natives.jar`
              }
            }
          },
          extract: { exclude: ['META-INF/'] }
        }
      ],
      logging: {
        client: {
          argument: '-Dlog4j.configurationFile=${path}',
          file: { id: 'client-test.xml', sha1: sha1(xmlPayload), size: xmlPayload.length, url: `${fixture.baseUrl}/client-test.xml` },
          type: 'log4j2-xml'
        }
      }
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-install-'))
    const progresses: number[] = []
    const result = await installVersion(versionJson, root, {
      os: { name: 'windows', arch: 'x64' },
      assetBaseUrl: fixture.baseUrl,
      onProgress: (p) => progresses.push(p.completed)
    })

    // client jar 与 version json 落盘
    expect(await fs.readFile(join(root, 'versions', 'test-1.0', 'test-1.0.jar'))).toEqual(clientPayload)
    const savedJson = JSON.parse(await fs.readFile(join(root, 'versions', 'test-1.0', 'test-1.0.json'), 'utf8'))
    expect(savedJson.id).toBe('test-1.0')

    // libraries：适用的下载，osx-only 排除
    expect(await fs.readFile(join(root, 'libraries', 'g/a/1.0/a-1.0.jar'))).toEqual(libPayload)
    await expect(fs.access(join(root, 'libraries', 'g/osx/1.0/osx-1.0.jar'))).rejects.toThrow()

    // natives 解压：dll 与普通文件保留，META-INF 排除
    expect(await fs.readFile(join(result.nativesDir, 'native.dll'))).toEqual(Buffer.from('fake-dll-content'))
    expect(await fs.readFile(join(result.nativesDir, 'other.txt'))).toEqual(Buffer.from('keep me'))
    await expect(fs.access(join(result.nativesDir, 'META-INF'))).rejects.toThrow()

    // assets：index 与 objects（同 hash 去重只下载一次）
    expect(await fs.readFile(join(root, 'assets', 'indexes', 'test-index.json'))).toEqual(Buffer.from(indexText))
    expect(await fs.readFile(join(root, 'assets', 'objects', assetPrefix, sha1(assetA)))).toEqual(assetA)
    expect(fixture.counts.get(`/${assetPrefix}/${sha1(assetA)}`)).toBe(1)

    // logging 配置
    expect(await fs.readFile(join(root, 'assets', 'log_configs', 'client-test.xml'))).toEqual(xmlPayload)
    expect(result.logging?.argument).toBe('-Dlog4j.configurationFile=${path}')
    expect(result.logging?.file).toContain(join('assets', 'log_configs', 'client-test.xml'))

    // 返回路径与进度
    expect(result.clientJar).toBe(join(root, 'versions', 'test-1.0', 'test-1.0.jar'))
    expect(result.nativesDir).toBe(join(root, 'versions', 'test-1.0', 'natives'))
    expect(result.assetsIndexId).toBe('test-index')
    expect(progresses.at(-1)).toBe(progresses.at(0)) // 进度单调
    expect(progresses.at(-1)).toBeGreaterThan(0)
  })

  it('重复安装时已存在且校验通过的文件不再发起请求', async () => {
    const clientPayload = randomBytes(1024)
    const fixture = await startFixture({ '/client.jar': clientPayload })
    servers.push(fixture.server)

    const versionJson: VersionJson = {
      id: 'reinstall-1.0',
      type: 'release',
      mainClass: 'C',
      libraries: [],
      downloads: {
        client: { sha1: sha1(clientPayload), size: clientPayload.length, url: `${fixture.baseUrl}/client.jar` }
      }
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-install-'))
    await installVersion(versionJson, root, { os: { name: 'windows' } })
    expect(fixture.counts.get('/client.jar')).toBe(1)

    await installVersion(versionJson, root, { os: { name: 'windows' } })
    expect(fixture.counts.get('/client.jar')).toBe(1) // 第二次命中缓存
  })

  it('安装成功写 .install-ok 标记；重装失败时标记被清除', async () => {
    const clientPayload = randomBytes(1024)
    const fixture = await startFixture({ '/client.jar': clientPayload })
    servers.push(fixture.server)

    const versionJson: VersionJson = {
      id: 'marker-1.0',
      type: 'release',
      mainClass: 'C',
      libraries: [],
      downloads: {
        client: { sha1: sha1(clientPayload), size: clientPayload.length, url: `${fixture.baseUrl}/client.jar` }
      }
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-install-'))
    await installVersion(versionJson, root, { os: { name: 'windows' } })
    const marker = join(root, 'versions', 'marker-1.0', '.install-ok')
    await expect(fs.access(marker)).resolves.toBeUndefined()

    // 重装（服务器 404）→ 开头清标记 → 失败后不残留（先删 jar 迫使重新下载）
    await fs.rm(join(root, 'versions', 'marker-1.0', 'marker-1.0.jar'))
    const broken: VersionJson = { ...versionJson, downloads: { client: { sha1: sha1(clientPayload), size: clientPayload.length, url: `${fixture.baseUrl}/missing` } } }
    await expect(installVersion(broken, root, { os: { name: 'windows' } })).rejects.toThrow(/共 1 个文件失败/)
    await expect(fs.access(marker)).rejects.toThrow()
  })

  it('assets objects fastSkip：size 一致的已存在文件不发请求，size 不符才重新下载', async () => {
    const assetOk = Buffer.from('asset-ok-content')
    const assetBad = Buffer.from('asset-bad-content')
    const indexJson = {
      objects: {
        'ok.txt': { hash: sha1(assetOk), size: assetOk.length },
        'bad.txt': { hash: sha1(assetBad), size: 999999 } // 声明的 size 与实际不符 → 必须下载
      }
    }
    const indexText = JSON.stringify(indexJson)
    const prefixOk = sha1(assetOk).slice(0, 2)
    const prefixBad = sha1(assetBad).slice(0, 2)

    const fixture = await startFixture({
      '/index.json': indexText,
      [`/${prefixOk}/${sha1(assetOk)}`]: assetOk,
      [`/${prefixBad}/${sha1(assetBad)}`]: assetBad
    })
    servers.push(fixture.server)

    const versionJson: VersionJson = {
      id: 'fastskip-1.0',
      type: 'release',
      mainClass: 'C',
      libraries: [],
      assetIndex: { id: 'fastskip', sha1: sha1(indexText), size: indexText.length, totalSize: 0, url: `${fixture.baseUrl}/index.json` },
      assets: 'fastskip'
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-install-'))
    // 预放一个 size 正确的 ok 资源；bad 资源缺失
    await fs.mkdir(join(root, 'assets', 'objects', prefixOk), { recursive: true })
    await fs.writeFile(join(root, 'assets', 'objects', prefixOk, sha1(assetOk)), assetOk)

    await installVersion(versionJson, root, { os: { name: 'windows' }, assetBaseUrl: fixture.baseUrl })

    expect(fixture.counts.get(`/${prefixOk}/${sha1(assetOk)}`)).toBeUndefined() // fastSkip 命中，零请求
    expect(fixture.counts.get(`/${prefixBad}/${sha1(assetBad)}`)).toBe(1) // size 不符 → 下载
  })

  it('多任务失败时聚合为一条错误', async () => {
    const fixture = await startFixture({}) // 全部 404
    servers.push(fixture.server)

    const versionJson: VersionJson = {
      id: 'aggregate-1.0',
      type: 'release',
      mainClass: 'C',
      libraries: [
        { name: 'g:a:1.0', downloads: { artifact: { path: 'g/a/1.0/a-1.0.jar', sha1: 'x'.repeat(40), size: 1, url: `${fixture.baseUrl}/missing-a` } } }
      ],
      downloads: {
        client: { sha1: 'x'.repeat(40), size: 1, url: `${fixture.baseUrl}/missing-b` }
      }
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-install-'))
    await expect(installVersion(versionJson, root, { os: { name: 'windows' } })).rejects.toThrow(/共 2 个文件失败/)
  })

  it('校验不匹配的已存在文件会被重新下载', async () => {
    const clientPayload = randomBytes(1024)
    const fixture = await startFixture({ '/client.jar': clientPayload })
    servers.push(fixture.server)

    const versionJson: VersionJson = {
      id: 'corrupt-1.0',
      type: 'release',
      mainClass: 'C',
      libraries: [],
      downloads: {
        client: { sha1: sha1(clientPayload), size: clientPayload.length, url: `${fixture.baseUrl}/client.jar` }
      }
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-install-'))
    const jar = join(root, 'versions', 'corrupt-1.0', 'corrupt-1.0.jar')
    await fs.mkdir(join(root, 'versions', 'corrupt-1.0'), { recursive: true })
    await fs.writeFile(jar, 'corrupted-content')

    await installVersion(versionJson, root, { os: { name: 'windows' } })
    expect(await fs.readFile(jar)).toEqual(clientPayload)
    expect(fixture.counts.get('/client.jar')).toBe(1)
  })
})

describe('installVersion 多源回退（libraryAltBaseUrls）', () => {
  const libPayload = Buffer.from('library-jar-content')
  const libPath = 'g/a/1.0/a-1.0.jar'

  function makeVersionJson(url: string): VersionJson {
    return {
      id: 'multi-1.0',
      type: 'release',
      mainClass: 'C',
      libraries: [
        {
          name: 'g:a:1.0',
          downloads: { artifact: { path: libPath, sha1: sha1(libPayload), size: libPayload.length, url } }
        }
      ]
    }
  }

  async function makeRoot(): Promise<string> {
    return fs.mkdtemp(join(tmpdir(), 'mcl-install-'))
  }

  it('主源 404 时立即回退备用源（非末位源不重试）', async () => {
    const main = await startFixture({}) // /g/a/1.0/1.0.jar 404
    servers.push(main.server)
    const alt = await startFixture({ [`/${libPath}`]: libPayload })
    servers.push(alt.server)

    const root = await makeRoot()
    await installVersion(makeVersionJson(`${main.baseUrl}/${libPath}`), root, {
      os: { name: 'windows' },
      libraryAltBaseUrls: [alt.baseUrl]
    })
    const dest = join(root, 'libraries', libPath)
    expect(await fs.readFile(dest)).toEqual(libPayload)
    expect(main.counts.get(`/${libPath}`)).toBe(1) // 主源只打了一次（retries=0 立即换源）
    expect(alt.counts.get(`/${libPath}`)).toBe(1)
  })

  it('主源返回脏内容（sha1 不符）时回退备用源', async () => {
    const main = await startFixture({ [`/${libPath}`]: Buffer.from('dirty-content') })
    servers.push(main.server)
    const alt = await startFixture({ [`/${libPath}`]: libPayload })
    servers.push(alt.server)

    const root = await makeRoot()
    await installVersion(makeVersionJson(`${main.baseUrl}/${libPath}`), root, {
      os: { name: 'windows' },
      libraryAltBaseUrls: [alt.baseUrl]
    })
    expect(await fs.readFile(join(root, 'libraries', libPath))).toEqual(libPayload)
  })

  it('末位备用源保留完整重试（网络错误重试 2 次后成功）', async () => {
    let mainRequests = 0
    let altAttempts = 0
    const main = createServer((req, res) => {
      mainRequests++
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve))
    servers.push(main)
    const mainPort = (main.address() as AddressInfo).port

    const alt = createServer((req, res) => {
      altAttempts++
      if (altAttempts <= 2) {
        res.writeHead(200, { 'Content-Length': String(libPayload.length) })
        res.write(libPayload.subarray(0, 8)) // 少于全长 → 停在半途
        setTimeout(() => res.destroy(), 20) // 中途断开 → terminated
        return
      }
      res.writeHead(200, { 'Content-Length': String(libPayload.length) })
      res.end(libPayload)
    })
    await new Promise<void>((resolve) => alt.listen(0, '127.0.0.1', resolve))
    servers.push(alt)
    const altPort = (alt.address() as AddressInfo).port

    const root = await makeRoot()
    await installVersion(makeVersionJson(`http://127.0.0.1:${mainPort}/${libPath}`), root, {
      os: { name: 'windows' },
      libraryAltBaseUrls: [`http://127.0.0.1:${altPort}`]
    })
    expect(mainRequests).toBe(1) // 主源 404 一次即换源（非末位源 retries=0）
    expect(altAttempts).toBe(3) // 末位源带完整重试
    expect(await fs.readFile(join(root, 'libraries', libPath))).toEqual(libPayload)
  })
})
