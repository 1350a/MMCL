import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installLocalMod, listMods, readOptionsTxt, removeMod, writeOptionsTxt } from '../src'

async function makeDir(): Promise<string> {
  const dir = join(tmpdir(), `mcl-mods-test-${randomBytes(6).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('mods 目录管理', () => {
  it('listMods：只列 .jar，按文件名排序；目录不存在返回空', async () => {
    const gameDir = await makeDir()
    expect(await listMods(gameDir)).toEqual([])
    await fs.mkdir(join(gameDir, 'mods'), { recursive: true })
    await fs.writeFile(join(gameDir, 'mods', 'b.jar'), 'bbb')
    await fs.writeFile(join(gameDir, 'mods', 'a.jar'), 'aa')
    await fs.writeFile(join(gameDir, 'mods', 'notes.txt'), 'not a mod')
    await fs.mkdir(join(gameDir, 'mods', 'sub.jar')) // 目录伪装成 jar 不算
    expect(await listMods(gameDir)).toEqual([
      { filename: 'a.jar', sizeBytes: 2 },
      { filename: 'b.jar', sizeBytes: 3 }
    ])
  })

  it('installLocalMod：复制 jar 进 mods/，同名覆盖', async () => {
    const gameDir = await makeDir()
    const src = join(gameDir, 'elsewhere')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(join(src, 'mod-x.jar'), 'v1')
    expect(await installLocalMod(gameDir, join(src, 'mod-x.jar'))).toBe('mod-x.jar')
    await fs.writeFile(join(src, 'mod-x.jar'), 'v2')
    await installLocalMod(gameDir, join(src, 'mod-x.jar'))
    expect(await fs.readFile(join(gameDir, 'mods', 'mod-x.jar'), 'utf8')).toBe('v2')
  })

  it('installLocalMod：非 .jar / 不存在的路径拒绝', async () => {
    const gameDir = await makeDir()
    await expect(installLocalMod(gameDir, join(gameDir, 'x.zip'))).rejects.toThrow(/\.jar/)
    await expect(installLocalMod(gameDir, join(gameDir, 'nope.jar'))).rejects.toThrow(/找不到/)
  })

  it('removeMod：删除存在的 jar；缺失与非法文件名报错', async () => {
    const gameDir = await makeDir()
    await fs.mkdir(join(gameDir, 'mods'), { recursive: true })
    await fs.writeFile(join(gameDir, 'mods', 'm.jar'), 'x')
    await removeMod(gameDir, 'm.jar')
    expect(await listMods(gameDir)).toEqual([])
    await expect(removeMod(gameDir, 'm.jar')).rejects.toThrow(/没有 m\.jar/)
    await expect(removeMod(gameDir, '../escape.jar')).rejects.toThrow(/非法/)
    await expect(removeMod(gameDir, 'C:\\evil.jar')).rejects.toThrow(/非法/)
    await expect(removeMod(gameDir, 'readme.txt')).rejects.toThrow(/非法/)
  })
})

describe('options.txt 读写', () => {
  it('文件不存在时读为空，写则创建', async () => {
    const gameDir = await makeDir()
    expect(await readOptionsTxt(gameDir)).toEqual([])
    const written = await writeOptionsTxt(gameDir, { fov: '0.75' })
    expect(written).toEqual([{ key: 'fov', value: '0.75' }])
    expect(await readOptionsTxt(gameDir)).toEqual([{ key: 'fov', value: '0.75' }])
    expect(await fs.readFile(join(gameDir, 'options.txt'), 'utf8')).toBe('fov:0.75\n')
  })

  it('已有 key 原位更新，新 key 追加，value 含冒号不破坏', async () => {
    const gameDir = await makeDir()
    await writeOptionsTxt(gameDir, { gamma: '1.0', key_keyInventory: 'key.keyboard.e' })
    const updated = await writeOptionsTxt(gameDir, { gamma: '2.0', musicVolume: '0.5' })
    expect(updated).toEqual([
      { key: 'gamma', value: '2.0' },
      { key: 'key_keyInventory', value: 'key.keyboard.e' },
      { key: 'musicVolume', value: '0.5' }
    ])
    expect(await readOptionsTxt(gameDir)).toEqual(updated)
  })

  it('异常行（无冒号/空 key）跳过，非法键名拒绝', async () => {
    const gameDir = await makeDir()
    await fs.mkdir(gameDir, { recursive: true })
    await fs.writeFile(join(gameDir, 'options.txt'), 'broken-line\n\nvalid:1\n')
    expect(await readOptionsTxt(gameDir)).toEqual([{ key: 'valid', value: '1' }])
    await expect(writeOptionsTxt(gameDir, { 'bad key!': '1' })).rejects.toThrow(/非法/)
  })
})
