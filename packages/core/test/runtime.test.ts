import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { AddressInfo } from 'node:net'
import { extractZip, installRuntime, listInstalledRuntimes, pickRuntime } from '../src'
import type { JavaInfo } from '../src'

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

/** 打一个模拟 Temurin 布局的 runtime zip：唯一顶层目录 jdk-<v>-jre/。 */
function makeRuntimeZip(topDir: string): Buffer {
  const zip = new AdmZip()
  zip.addFile(`${topDir}/bin/java.exe`, Buffer.from('fake-java-binary'))
  zip.addFile(`${topDir}/bin/server/jvm.dll`, Buffer.from('fake-jvm'))
  zip.addFile(`${topDir}/release`, Buffer.from('JAVA_VERSION="17.0.9"'))
  return zip.toBuffer()
}

const okProbe = (expectedMajor: number) =>
  async (_javaPath: string): Promise<JavaInfo> => ({ path: 'x', majorVersion: expectedMajor, raw: String(expectedMajor) })

describe('extractZip', () => {
  it('解压写盘、exclude 前缀跳过、拒绝 .. 条目（zip-slip）', async () => {
    const zip = new AdmZip()
    zip.addFile('a/b.txt', Buffer.from('keep'))
    zip.addFile('META-INF/x', Buffer.from('drop'))
    zip.addFile('../evil.txt', Buffer.from('evil'))
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-zip-'))
    const zipPath = join(dir, 'in.zip')
    await fs.writeFile(zipPath, zip.toBuffer())

    const progress: Array<[number, number]> = []
    await extractZip(zipPath, join(dir, 'out'), {
      exclude: ['META-INF/'],
      onProgress: (done, total) => progress.push([done, total])
    })

    expect(await fs.readFile(join(dir, 'out', 'a', 'b.txt'))).toEqual(Buffer.from('keep'))
    await expect(fs.access(join(dir, 'out', 'META-INF'))).rejects.toThrow()
    await expect(fs.access(join(dir, 'evil.txt'))).rejects.toThrow()
    expect(progress.at(-1)).toEqual([2, 3]) // 3 条目，1 条被 exclude
  })
})

describe('installRuntime', () => {
  /** Adoptium API + zip 下载的本地 fixture；officialBroken=true 时官方 zip 路由 404，镜像路由可用。 */
  async function startAdoptiumFixture(zip: Buffer, emptyGA = false, officialBroken = false): Promise<string> {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/assets/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const body = emptyGA
          ? []
          : [
              {
                version: { major: 17 },
                binary: {
                  package: {
                    name: 'OpenJDK17U-jre_x64_windows_hotspot_17.0.9.1_2.zip',
                    link: 'http://unused/jre.zip',
                    size: zip.length,
                    checksum: sha256(zip)
                  }
                }
              }
            ]
        // 把 package.link 换成本地地址
        if (!emptyGA) {
          const { port } = server.address() as AddressInfo
          body[0].binary.package.link = `http://127.0.0.1:${port}/jre.zip`
        }
        res.end(JSON.stringify(body))
        return
      }
      if (req.url === '/jre.zip' && !officialBroken) {
        res.writeHead(200, { 'Content-Length': String(zip.length) })
        res.end(zip)
        return
      }
      if (officialBroken && /^\/mirror\/17\/jre\/x64\/windows\//.test(req.url ?? '')) {
        res.writeHead(200, { 'Content-Length': String(zip.length) })
        res.end(zip)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}/assets`
  }

  it('完整流程：查资产 → sha256 下载 → 解压 → 顶层提升 → 自检 → 完成标记', async () => {
    const zip = makeRuntimeZip('jdk-17.0.9.1-jre')
    const apiBase = await startAdoptiumFixture(zip)
    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-runtime-'))

    const phases: string[] = []
    const info = await installRuntime(root, 17, {
      apiBaseUrl: apiBase,
      probe: okProbe(17),
      onProgress: (p) => phases.push(p.phase)
    })

    expect(info.major).toBe(17)
    expect(info.javaPath).toContain(join('runtimes', 'java-17', 'bin', 'java.exe'))
    expect(await fs.readFile(join(root, 'runtimes', 'java-17', 'bin', 'java.exe'))).toEqual(Buffer.from('fake-java-binary'))
    expect(await fs.readFile(join(root, 'runtimes', 'java-17', 'release'))).toEqual(Buffer.from('JAVA_VERSION="17.0.9"'))
    await expect(fs.access(join(root, 'runtimes', 'java-17', '.install-ok'))).resolves.toBeUndefined()
    // staging（zip + extract）已清理
    await expect(fs.access(`${join(root, 'runtimes', 'java-17')}.staging`)).rejects.toThrow()
    expect(phases).toContain('download')
    expect(phases).toContain('extract')
  })

  it('自检 major 不符 → 抛错且无完成标记（半成品不进列表）', async () => {
    const zip = makeRuntimeZip('jdk-21.0.0-jre')
    const apiBase = await startAdoptiumFixture(zip)
    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-runtime-'))

    await expect(
      installRuntime(root, 17, { apiBaseUrl: apiBase, probe: okProbe(21) })
    ).rejects.toThrow(/self-check failed/)

    const runtimes = await listInstalledRuntimes(root)
    expect(runtimes).toEqual([])
  })

  it('官方源失败自动回退清华镜像（官方 404 → 镜像命中，sha256 沿用 API 值）', async () => {
    const zip = makeRuntimeZip('jdk-17.0.9.1-jre')
    const apiBase = await startAdoptiumFixture(zip, false, true)
    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-runtime-'))

    const info = await installRuntime(root, 17, {
      apiBaseUrl: apiBase,
      mirrorBaseUrl: apiBase.replace('/assets', '/mirror'),
      probe: okProbe(17)
    })
    expect(info.major).toBe(17)
    expect(await fs.readFile(join(root, 'runtimes', 'java-17', 'bin', 'java.exe'))).toEqual(Buffer.from('fake-java-binary'))
    await expect(fs.access(join(root, 'runtimes', 'java-17', '.install-ok'))).resolves.toBeUndefined()
  })

  it('Adoptium 无 GA（空数组）→ 抛清晰错误', async () => {
    const apiBase = await startAdoptiumFixture(Buffer.alloc(0), true)
    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-runtime-'))
    await expect(
      installRuntime(root, 16, { apiBaseUrl: apiBase, probe: okProbe(16) })
    ).rejects.toThrow(/无 Java 16 的 JRE GA/)
  })

  it('非法 major 参数直接拒绝', async () => {
    await expect(installRuntime('x', 0)).rejects.toThrow(/invalid java major/)
  })
})

describe('listInstalledRuntimes / pickRuntime', () => {
  it('只返回带标记且 bin/java.exe 存在的 runtime；pickRuntime 取满足需求的最小版本', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-runtime-'))
    for (const [name, withMarker] of [
      ['java-17', true],
      ['java-21', true],
      ['java-8', false], // 半成品，无标记
      ['not-a-runtime', true] // 目录名不合法
    ] as const) {
      const dir = join(root, 'runtimes', name)
      await fs.mkdir(join(dir, 'bin'), { recursive: true })
      await fs.writeFile(join(dir, 'bin', 'java.exe'), 'x')
      if (withMarker) await fs.writeFile(join(dir, '.install-ok'), 'ok')
    }

    const runtimes = await listInstalledRuntimes(root)
    expect(runtimes.map((r) => r.major)).toEqual([17, 21])
    expect(pickRuntime(runtimes, 17)?.major).toBe(17)
    expect(pickRuntime(runtimes, 20)?.major).toBe(21)
    expect(pickRuntime(runtimes, 22)).toBeUndefined()
  })

  it('无 runtimes 目录时返回空数组', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'mcl-runtime-'))
    expect(await listInstalledRuntimes(root)).toEqual([])
  })
})
