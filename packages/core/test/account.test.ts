import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InvalidPlayerNameError,
  loadAccounts,
  offlineUuid,
  saveAccounts,
  validatePlayerName
} from '../src'

// 金标值来自本机 JRE 8 官方实现：
// jjs 执行 java.util.UUID.nameUUIDFromBytes(("OfflinePlayer:<name>").getBytes("UTF-8"))
const GOLDEN: Record<string, string> = {
  Notch: 'b50ad385-829d-3141-a216-7e7d7539ba7f',
  alex: 'bf20048c-a55a-322c-a100-5493e7b87286',
  Alex: '36532b5e-c442-3dbb-a24c-c7e55d0f979a',
  Player_123: '592ac8aa-a392-3300-916e-00427a650c3b'
}

describe('offlineUuid', () => {
  it('与 Java 官方 nameUUIDFromBytes 输出一致（JRE 8 金标）', () => {
    for (const [name, uuid] of Object.entries(GOLDEN)) {
      expect(offlineUuid(name)).toBe(uuid)
    }
  })

  it('玩家名大小写敏感，不同名字 UUID 不同', () => {
    expect(offlineUuid('alex')).not.toBe(offlineUuid('Alex'))
  })
})

describe('validatePlayerName', () => {
  it('合法名字通过，非法名字抛 InvalidPlayerNameError', () => {
    expect(() => validatePlayerName('Player_123')).not.toThrow()
    expect(() => validatePlayerName('ab')).toThrow(InvalidPlayerNameError) // 太短
    expect(() => validatePlayerName('a'.repeat(17))).toThrow(InvalidPlayerNameError) // 太长
    expect(() => validatePlayerName('玩家')).toThrow(InvalidPlayerNameError) // 非法字符
    expect(() => validatePlayerName('bad name')).toThrow(InvalidPlayerNameError)
  })
})

describe('账户持久化', () => {
  it('saveAccounts 覆盖 uuid 为离线 UUID，loadAccounts 读回一致', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    await saveAccounts(dir, [{ kind: 'offline', name: 'Notch', uuid: 'will-be-overwritten' }])
    const accounts = await loadAccounts(dir)
    expect(accounts).toEqual([{ kind: 'offline', name: 'Notch', uuid: GOLDEN.Notch }])
  })

  it('文件不存在 / 非法 JSON / 结构不对时 loadAccounts 返回空数组', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    expect(await loadAccounts(dir)).toEqual([])

    await fs.writeFile(join(dir, 'accounts.json'), 'not json')
    expect(await loadAccounts(dir)).toEqual([])

    await fs.writeFile(join(dir, 'accounts.json'), '{"accounts": [{"name": "ab", "uuid": "x"}]}')
    expect(await loadAccounts(dir)).toEqual([]) // 玩家名非法的条目被过滤
  })

  it('saveAccounts 对非法玩家名抛错且不写文件', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    await expect(
      saveAccounts(dir, [{ kind: 'offline', name: 'ab', uuid: '' }])
    ).rejects.toBeInstanceOf(InvalidPlayerNameError)
    await expect(loadAccounts(dir)).resolves.toEqual([])
  })
})

describe('Yggdrasil 账户持久化（M3 外置登录）', () => {
  const ygAccount = {
    kind: 'yggdrasil' as const,
    name: 'Steve',
    uuid: 'a'.repeat(32), // 服务端 profile UUID，无连字符（规范序列化形式）
    apiRoot: 'https://auth.example.com/api/yggdrasil/',
    accessToken: 'token-1',
    clientToken: 'ct-1',
    serverName: '测试服'
  }

  it('roundtrip：服务端 uuid/token/apiRoot 原样保留，不被离线 UUID 覆盖', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const serverAccount = { ...ygAccount, uuid: 'server-provided-uuid' }
    await saveAccounts(dir, [serverAccount])
    const accounts = await loadAccounts(dir)
    expect(accounts).toEqual([serverAccount]) // uuid 仍为写入的服务端值
    expect(accounts[0].kind).toBe('yggdrasil')
  })

  it('离线与 Yggdrasil 账户可共存写入（单活跃账户由上层保证）', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const offline = { kind: 'offline' as const, name: 'Notch', uuid: 'x' }
    await saveAccounts(dir, [offline, ygAccount])
    const accounts = await loadAccounts(dir)
    expect(accounts).toEqual([
      { kind: 'offline', name: 'Notch', uuid: GOLDEN.Notch },
      ygAccount
    ])
  })

  it('旧格式（无 kind 字段，M1/M2 时代）读入时视为离线账户', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    await fs.writeFile(
      join(dir, 'accounts.json'),
      JSON.stringify({ accounts: [{ name: 'Notch', uuid: 'ignored' }] })
    )
    const accounts = await loadAccounts(dir)
    expect(accounts).toEqual([{ kind: 'offline', name: 'Notch', uuid: 'ignored' }])
  })

  it('字段残缺的 yggdrasil 条目（缺 apiRoot/token）被过滤', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    await fs.writeFile(
      join(dir, 'accounts.json'),
      JSON.stringify({
        accounts: [
          { kind: 'yggdrasil', name: 'Broken', uuid: 'u' },
          ygAccount
        ]
      })
    )
    const accounts = await loadAccounts(dir)
    expect(accounts).toEqual([ygAccount])
  })

  it('yggdrasil 账户名字允许服务器自定义（非 ASCII 也接受），空名拒绝', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-core-'))
    const cnName = { ...ygAccount, name: '中文名玩家' }
    await saveAccounts(dir, [cnName])
    expect((await loadAccounts(dir))[0].name).toBe('中文名玩家')

    await expect(
      saveAccounts(dir, [{ ...ygAccount, name: '' }])
    ).rejects.toBeInstanceOf(InvalidPlayerNameError)
  })
})
