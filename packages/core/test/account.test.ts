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
    await saveAccounts(dir, [{ name: 'Notch', uuid: 'will-be-overwritten' }])
    const accounts = await loadAccounts(dir)
    expect(accounts).toEqual([{ name: 'Notch', uuid: GOLDEN.Notch }])
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
    await expect(saveAccounts(dir, [{ name: 'ab', uuid: '' }])).rejects.toBeInstanceOf(
      InvalidPlayerNameError
    )
    await expect(loadAccounts(dir)).resolves.toEqual([])
  })
})
