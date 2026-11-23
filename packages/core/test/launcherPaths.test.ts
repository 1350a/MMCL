import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertDirWritable,
  ensureGameDirs,
  fallbackGameRoot,
  officialGameRoot,
  resolveGameRoot,
  resolveMmclDir,
  resolveWorkspaceDir
} from '../src'

describe('resolveMmclDir / resolveWorkspaceDir', () => {
  it('固定为 %USERPROFILE%\\.mmcl 及其下的 workspace', () => {
    expect(resolveMmclDir('C:/Users/mac')).toBe(join('C:/Users/mac', '.mmcl'))
    expect(resolveWorkspaceDir('C:/Users/mac/.mmcl')).toBe(join('C:/Users/mac/.mmcl', 'workspace'))
    expect(officialGameRoot('C:/Users/mac/AppData/Roaming')).toBe(
      join('C:/Users/mac/AppData/Roaming', '.minecraft')
    )
    expect(fallbackGameRoot('C:/Users/mac/.mmcl')).toBe(join('C:/Users/mac/.mmcl', '.minecraft'))
  })
})

describe('resolveGameRoot（游戏根解析）', () => {
  const mmclDir = 'C:/Users/mac/.mmcl'

  it('记忆路径存在：直接用（memory）', () => {
    const res = resolveGameRoot({
      mmclDir,
      lastGameRoot: 'D:/games/mc',
      officialGameRoot: 'C:/official/.minecraft',
      exists: (p) => p === 'D:/games/mc'
    })
    expect(res).toEqual({ root: 'D:/games/mc', source: 'memory' })
  })

  it('记忆路径消失：警告 + 兜底 .mmcl\\.minecraft（fallback）', () => {
    const res = resolveGameRoot({
      mmclDir,
      lastGameRoot: 'D:/gone',
      exists: () => false
    })
    expect(res.root).toBe(join(mmclDir, '.minecraft'))
    expect(res.source).toBe('fallback')
    expect(res.warning).toContain('D:/gone')
  })

  it('首次（无记忆）：官启目录存在即用（official）', () => {
    const official = officialGameRoot('C:/Users/mac/AppData/Roaming')
    const res = resolveGameRoot({
      mmclDir,
      officialGameRoot: official,
      exists: (p) => p === official
    })
    expect(res).toEqual({ root: official, source: 'official' })
  })

  it('首次且无官启目录：兜底新建（fallback，无警告）', () => {
    const res = resolveGameRoot({ mmclDir, officialGameRoot: 'C:/nowhere', exists: () => false })
    expect(res).toEqual({ root: join(mmclDir, '.minecraft'), source: 'fallback' })
  })

  it('官启目录存在但已有记忆：记忆优先', () => {
    const res = resolveGameRoot({
      mmclDir,
      lastGameRoot: 'D:/games/mc',
      officialGameRoot: 'C:/official/.minecraft',
      exists: (p) => p !== 'C:/official/.minecraft'
    })
    expect(res.root).toBe('D:/games/mc')
  })
})

describe('ensureGameDirs（缺什么文件夹补建什么）', () => {
  it('一次性补齐标准子目录；重复调用幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcl-gameroot-test-'))
    await ensureGameDirs(root)
    const first = await readdir(root)
    for (const d of ['versions', 'libraries', 'assets', 'instances', 'saves', 'screenshots', 'logs', 'mods', 'config']) {
      expect(first).toContain(d)
    }
    await ensureGameDirs(root) // 幂等
    expect((await readdir(root)).length).toBe(first.length)
    await rm(root, { recursive: true, force: true })
  })
})

describe('assertDirWritable（目录可写校验）', () => {
  it('可写目录通过；不存在时先创建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcl-writable-test-'))
    const target = join(root, 'new-root')
    await assertDirWritable(target)
    expect(await readdir(target)).toEqual([]) // 探测文件已清理
    await assertDirWritable(root) // 已存在目录同样通过
    await rm(root, { recursive: true, force: true })
  })

  it('不可写路径报错并带上目录与原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcl-unwritable-test-'))
    const file = join(root, 'occupied')
    await (await import('node:fs/promises')).writeFile(file, 'x')
    // 父路径是文件：mkdir 必然失败（跨平台稳定，不依赖 ACL）
    await expect(assertDirWritable(join(file, 'sub'))).rejects.toThrow(/目录不可写/)
    await rm(root, { recursive: true, force: true })
  })
})
