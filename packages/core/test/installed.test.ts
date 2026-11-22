import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { AddressInfo } from 'node:net'
import { assembleLaunch, installFabric, mergeVersionJson, resolveInstalledVersion } from '../src'
import type { VersionJson } from '../src'

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
  const dir = join(tmpdir(), `mcl-installed-test-${randomBytes(6).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function writeVersion(root: string, json: VersionJson): Promise<void> {
  const dir = join(root, 'versions', json.id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `${json.id}.json`), JSON.stringify(json))
}

const vanilla: VersionJson = {
  id: '1.16.5',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'] },
  assetIndex: { id: '1.16', sha1: 'a'.repeat(40), size: 1, totalSize: 2, url: 'http://a/1.16.json' },
  javaVersion: { component: 'jre-legacy', majorVersion: 8 },
  downloads: { client: { sha1: 'v', size: 3, url: 'http://a/client.jar' } },
  libraries: [
    { name: 'com.mojang:vanilla-only:1.0' },
    { name: 'org.ow2.asm:asm:9.0', downloads: { artifact: { sha1: 'old', size: 1, url: 'http://a/asm-9.0.jar' } } }
  ]
}

const fabric: VersionJson = {
  id: 'fabric-loader-0.20.1-1.16.5',
  type: 'release',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  inheritsFrom: '1.16.5',
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
  libraries: [
    { name: 'org.ow2.asm:asm:9.10.1', downloads: { artifact: { sha1: 'new', size: 2, url: 'http://f/asm.jar' } } },
    { name: 'net.fabricmc:fabric-loader:0.20.1', url: 'https://maven.fabricmc.net/' }
  ]
}

async function installParentFiles(root: string): Promise<void> {
  await writeVersion(root, vanilla)
  await fs.mkdir(join(root, 'versions', '1.16.5', 'natives'), { recursive: true })
  await fs.writeFile(join(root, 'versions', '1.16.5', '1.16.5.jar'), 'vanilla-jar')
}

describe('resolveInstalledVersion', () => {
  it('无继承的常规版本：原样返回 + 常规 client jar 路径', async () => {
    const root = await makeRoot()
    await installParentFiles(root)
    const resolved = await resolveInstalledVersion(root, '1.16.5')
    expect(resolved.json.mainClass).toBe('net.minecraft.client.main.Main')
    expect(resolved.clientJarPath).toBe(join(root, 'versions', '1.16.5', '1.16.5.jar'))
    expect('inheritsFrom' in resolved.json).toBe(false)
  })

  it('fabric 子版本：标量子优先、库合并（子覆盖父）、client jar 指向父版本', async () => {
    const root = await makeRoot()
    await installParentFiles(root)
    await writeVersion(root, fabric)
    const resolved = await resolveInstalledVersion(root, 'fabric-loader-0.20.1-1.16.5')
    expect(resolved.json.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(resolved.json.assetIndex).toEqual(vanilla.assetIndex) // 子没有，继承父
    expect(resolved.json.javaVersion).toEqual({ component: 'jre-legacy', majorVersion: 8 })
    expect(resolved.json.libraries.map((l) => l.name)).toEqual([
      'org.ow2.asm:asm:9.10.1', // 子覆盖父同名（group:artifact）
      'net.fabricmc:fabric-loader:0.20.1',
      'com.mojang:vanilla-only:1.0'
    ])
    expect(resolved.json.arguments?.jvm).toEqual([
      '-Djava.library.path=${natives_directory}',
      '-cp',
      '${classpath}',
      '-DFabricMcEmu= net.minecraft.client.main.Main '
    ])
    expect(resolved.clientJarPath).toBe(join(root, 'versions', '1.16.5', '1.16.5.jar'))
    expect('inheritsFrom' in resolved.json).toBe(false)
  })

  it('三级继承链逐级合并', async () => {
    const root = await makeRoot()
    const grandparent: VersionJson = { ...vanilla, id: '1.0', mainClass: 'gp.Main', libraries: [{ name: 'g:gp-lib:1' }] }
    const parent: VersionJson = {
      id: '1.0-mid',
      type: 'release',
      mainClass: 'mid.Main',
      inheritsFrom: '1.0',
      libraries: [{ name: 'g:mid-lib:1' }]
    }
    const child: VersionJson = { ...fabric, id: 'child', inheritsFrom: '1.0-mid', mainClass: 'child.Main', libraries: [{ name: 'g:child-lib:1' }] }
    for (const j of [grandparent, parent, child]) {
      await writeVersion(root, j)
      await fs.writeFile(join(root, 'versions', j.id, `${j.id}.jar`), 'jar')
    }
    const resolved = await resolveInstalledVersion(root, 'child')
    expect(resolved.json.mainClass).toBe('child.Main')
    expect(resolved.json.libraries.map((l) => l.name)).toEqual(['g:child-lib:1', 'g:mid-lib:1', 'g:gp-lib:1'])
    expect(resolved.clientJarPath).toBe(join(root, 'versions', '1.0', '1.0.jar'))
  })

  it('父版本未安装给出可读错误', async () => {
    const root = await makeRoot()
    await writeVersion(root, fabric)
    await expect(resolveInstalledVersion(root, 'fabric-loader-0.20.1-1.16.5')).rejects.toThrow(/1\.16\.5 未安装/)
  })

  it('根版本缺 client jar 报错', async () => {
    const root = await makeRoot()
    await writeVersion(root, vanilla)
    await writeVersion(root, fabric)
    await expect(resolveInstalledVersion(root, 'fabric-loader-0.20.1-1.16.5')).rejects.toThrow(/client jar 缺失/)
  })

  it('版本未安装 / JSON 损坏分别报错', async () => {
    const root = await makeRoot()
    await expect(resolveInstalledVersion(root, 'nope')).rejects.toThrow(/nope 未安装/)
    const dir = join(root, 'versions', 'broken')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'broken.json'), 'not json{')
    await expect(resolveInstalledVersion(root, 'broken')).rejects.toThrow(/JSON 损坏/)
  })
})

describe('assembleLaunch clientJarPath 覆盖', () => {
  it('继承版本场景：classpath 用覆盖路径而非 versions/<id>/<id>.jar', () => {
    const root = '/game-root'
    const override = join('/game-root/versions/1.16.5/1.16.5.jar')
    const merged = mergeVersionJson(fabric, vanilla) // 启动前由 resolveInstalledVersion 产出
    const spec = assembleLaunch(merged, {
      javaPath: 'java.exe',
      account: { kind: 'offline', name: 'Notch', uuid: 'u' },
      gameDir: join(root, 'instances/main'),
      rootDir: root,
      os: { name: 'windows', arch: 'x64' },
      clientJarPath: override
    })
    const entries = spec.jvmArgs[spec.jvmArgs.indexOf('-cp') + 1].split(';')
    expect(entries.at(-1)).toBe(override)
    expect(entries).not.toContain(join(root, 'versions', 'fabric-loader-0.20.1-1.16.5', 'fabric-loader-0.20.1-1.16.5.jar'))
    expect(spec.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
  })

  it('缺省行为不变：仍取 versions/<id>/<id>.jar', () => {
    const root = '/game-root'
    const spec = assembleLaunch(vanilla, {
      javaPath: 'java.exe',
      account: { kind: 'offline', name: 'Notch', uuid: 'u' },
      gameDir: join(root, 'instances/main'),
      rootDir: root,
      os: { name: 'windows', arch: 'x64' }
    })
    const entries = spec.jvmArgs[spec.jvmArgs.indexOf('-cp') + 1].split(';')
    expect(entries.at(-1)).toBe(join(root, 'versions', '1.16.5', '1.16.5.jar'))
  })
})

describe('installFabric 解压父版本 natives', () => {
  it('安装后 fabric 版本目录含 natives（从父版本 classifier jar 解压）', async () => {
    // natives jar fixture：内含 fake-native.dll
    const nativeJar = new AdmZip()
    nativeJar.addFile('fake-native.dll', Buffer.from('dll-bytes'))
    nativeJar.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0'))
    const jarBuffer = nativeJar.toBuffer()

    let port = 0
    const server = createServer((req, res) => {
      const base = `http://127.0.0.1:${port}`
      if (req.url === `/versions/loader/1.16.5/0.20.1/profile/json`) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'fabric-loader-0.20.1-1.16.5',
            inheritsFrom: '1.16.5',
            type: 'release',
            mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
            arguments: { game: [], jvm: [] },
            libraries: [{ name: 'net.fabricmc:fabric-loader:0.20.1', url: `${base}/maven/` }]
          })
        )
        return
      }
      if (req.url === '/maven/net/fabricmc/fabric-loader/0.20.1/fabric-loader-0.20.1.jar') {
        res.writeHead(200, { 'Content-Length': String(4) })
        res.end('load')
        return
      }
      // 父版本的 natives classifier jar（安装父版本时已下载）
      if (req.url === '/libraries/com/example/native-lib/1.0/native-lib-1.0-natives-windows.jar') {
        res.writeHead(200, { 'Content-Length': String(jarBuffer.length) })
        res.end(jarBuffer)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`

    const root = await makeRoot()
    // 父版本：一条带 natives-windows classifier 的库 + json + jar（json 写死 classifier URL 指向 fixture）
    const parent: VersionJson = {
      id: '1.16.5',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      libraries: [
        {
          name: 'com.example:native-lib:1.0',
          downloads: {
            artifact: { sha1: sha1('art'), size: 3, url: `${base}/libraries/com/example/native-lib/1.0/native-lib-1.0.jar` },
            classifiers: {
              'natives-windows': {
                path: 'com/example/native-lib/1.0/native-lib-1.0-natives-windows.jar',
                sha1: sha1(jarBuffer),
                size: jarBuffer.length,
                url: `${base}/libraries/com/example/native-lib/1.0/native-lib-1.0-natives-windows.jar`
              }
            }
          }
        }
      ]
    }
    await writeVersion(root, parent)
    await fs.writeFile(join(root, 'versions', '1.16.5', '1.16.5.jar'), 'vanilla-jar')
    // 预置父 natives jar（模拟父版本已安装完成）
    const classifierPath = join(root, 'libraries', 'com/example/native-lib/1.0/native-lib-1.0-natives-windows.jar')
    await fs.mkdir(join(classifierPath, '..'), { recursive: true })
    await fs.writeFile(classifierPath, jarBuffer)

    await installFabric(root, '1.16.5', '0.20.1', { metaBaseUrl: base })
    const nativesDir = join(root, 'versions', 'fabric-loader-0.20.1-1.16.5', 'natives')
    const dll = await fs.readFile(join(nativesDir, 'fake-native.dll'), 'utf8')
    expect(dll).toBe('dll-bytes')
    // META-INF 默认排除
    await expect(fs.access(join(nativesDir, 'META-INF'))).rejects.toThrow()
  })
})
