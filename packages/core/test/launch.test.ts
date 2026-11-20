import { describe, expect, it } from 'vitest'
import { assembleLaunch } from '../src'
import type { VersionJson } from '../src'

const winSep = ';'

describe('assembleLaunch（新式 arguments，1.13+）', () => {
  // 精简自官方 1.16.5 版本 JSON 的真实结构
  const versionJson: VersionJson = {
    id: '1.16.5',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { component: 'jre-legacy', majorVersion: 8 },
    arguments: {
      jvm: [
        { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
        { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:HeapDumpPath=heapdump' },
        { rules: [{ action: 'allow', os: { name: 'windows', version: '^10\\.' } }], value: ['-Dos.name=Windows 10'] },
        '-Djava.library.path=${natives_directory}',
        '-Djna.tmpdir=${natives_directory}',
        '-cp',
        '${classpath}'
      ],
      game: [
        '--username',
        '${auth_player_name}',
        '--version',
        '${version_name}',
        '--gameDir',
        '${game_directory}',
        '--assetsDir',
        '${assets_root}',
        '--assetIndex',
        '${assets_index_name}',
        '--uuid',
        '${auth_uuid}',
        '--accessToken',
        '${auth_access_token}',
        '--userType',
        '${user_type}',
        {
          rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}']
        }
      ]
    },
    assetIndex: { id: '1.16', sha1: 'a', size: 1, totalSize: 2, url: 'http://x' },
    libraries: [
      { name: 'g:a:1.0', downloads: { artifact: { path: 'g/a/1.0/a-1.0.jar', sha1: 'x', size: 1, url: 'http://x/a.jar' } } },
      { name: 'g:osx:1.0', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'g/osx/1.0/osx-1.0.jar', sha1: 'x', size: 1, url: 'http://x/o.jar' } } }
    ],
    logging: {
      client: {
        argument: '-Dlog4j.configurationFile=${path}',
        file: { id: 'client-1.12.xml', sha1: 'x', size: 1, url: 'http://x/cfg' },
        type: 'log4j2-xml'
      }
    }
  }

  const options = {
    javaPath: 'C:/Java8/bin/java.exe',
    account: { name: 'Notch', uuid: 'b50ad385-829d-3141-a216-7e7d7539ba7f' },
    gameDir: 'C:\\instances\\main',
    rootDir: 'C:\\mcl-root',
    extraJvmArgs: ['-Xmx4G'],
    os: { name: 'windows', arch: 'x64' }
  }

  const spec = assembleLaunch(versionJson, options)

  it('javaPath 与 cwd、主类正确', () => {
    expect(spec.javaPath).toBe('C:/Java8/bin/java.exe')
    expect(spec.cwd).toBe('C:\\instances\\main')
    expect(spec.mainClass).toBe('net.minecraft.client.main.Main')
  })

  it('JVM 参数：logging + 用户附加 + osx 规则排除 + 变量替换', () => {
    expect(spec.jvmArgs[0]).toBe('-Xmx4G')
    expect(spec.jvmArgs).toContain('-Dlog4j.configurationFile=C:\\mcl-root\\assets\\log_configs\\client-1.12.xml')
    expect(spec.jvmArgs).toContain('-XX:HeapDumpPath=heapdump')
    expect(spec.jvmArgs).toContain('-Dos.name=Windows 10')
    expect(spec.jvmArgs).not.toContain('-XstartOnFirstThread') // osx-only 被排除
    expect(spec.jvmArgs).toContain('-Djava.library.path=C:\\mcl-root\\versions\\1.16.5\\natives')
    expect(spec.jvmArgs).toContain('-cp')
    const cp = spec.jvmArgs[spec.jvmArgs.indexOf('-cp') + 1]
    expect(cp).toContain('g\\a\\1.0\\a-1.0.jar')
    expect(cp).not.toContain('osx-1.0.jar') // osx 库不进 classpath
    expect(cp.endsWith(`C:\\mcl-root\\versions\\1.16.5\\1.16.5.jar`)).toBe(true)
    expect(cp.split(winSep).length).toBe(2) // 一个 library + client jar
  })

  it('游戏参数：账户与路径变量替换，feature 未启用时分辨率参数不出现', () => {
    expect(spec.gameArgs).toContain('Notch')
    expect(spec.gameArgs).toContain('b50ad385-829d-3141-a216-7e7d7539ba7f')
    expect(spec.gameArgs).toContain('C:\\instances\\main')
    expect(spec.gameArgs).toContain('1.16')
    expect(spec.gameArgs).toContain('0') // accessToken 默认
    expect(spec.gameArgs).not.toContain('--width')
    expect(spec.gameArgs.join(' ')).not.toContain('${')
  })

  it('启用 has_custom_resolution 特性时输出分辨率参数', () => {
    const spec2 = assembleLaunch(versionJson, {
      ...options,
      features: { has_custom_resolution: true }
    })
    const i = spec2.gameArgs.indexOf('--width')
    expect(i).toBeGreaterThan(0)
    expect(spec2.gameArgs[i + 1]).toBe('${resolution_width}') // 未提供分辨率变量时保留原样
  })
})

describe('assembleLaunch（旧式 minecraftArguments，≤1.12）', () => {
  const versionJson: VersionJson = {
    id: '1.12.2',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments:
      '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --versionType ${version_type}',
    assetIndex: { id: '1.12', sha1: 'a', size: 1, totalSize: 2, url: 'http://x' },
    libraries: [
      { name: 'g:a:1.0', url: 'http://repo.example/' }
    ]
  }

  it('无 arguments.jvm 时使用默认 JVM 参数，旧式库按 mavenPath 进 classpath', () => {
    const spec = assembleLaunch(versionJson, {
      javaPath: 'java',
      account: { name: 'Player', uuid: 'u' },
      gameDir: 'D:\\game dir with space',
      rootDir: 'D:\\root',
      os: { name: 'windows', arch: 'x64' }
    })
    expect(spec.jvmArgs).toContain('-Djava.library.path=D:\\root\\versions\\1.12.2\\natives')
    const cp = spec.jvmArgs[spec.jvmArgs.indexOf('-cp') + 1]
    expect(cp).toContain('g\\a\\1.0\\a-1.0.jar')

    // 旧式参数：token 化后逐个替换，含空格的 gameDir 不被拆散
    const i = spec.gameArgs.indexOf('D:\\game dir with space')
    expect(i).toBeGreaterThan(0)
    expect(spec.gameArgs[i - 1]).toBe('--gameDir')
    expect(spec.gameArgs).toContain('1.12') // assets_index_name
  })
})
