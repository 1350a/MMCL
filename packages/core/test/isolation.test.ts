import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteVersionArtifacts,
  ISOLATION_STRATEGIES,
  isIsolationStrategy,
  resolveIsolation,
  strategyCovers,
  updateInstance
} from '../src'

describe('strategyCovers（§3 策略矩阵）', () => {
  const facts = {
    正式版: { isSnapshot: false, isMod: false },
    快照版: { isSnapshot: true, isMod: false },
    mod正式: { isSnapshot: false, isMod: true },
    mod快照: { isSnapshot: true, isMod: true }
  }

  const expectMatrix = (strategy: Parameters<typeof strategyCovers>[0], want: [boolean, boolean, boolean, boolean]): void => {
    expect(strategyCovers(strategy, facts.正式版)).toBe(want[0])
    expect(strategyCovers(strategy, facts.快照版)).toBe(want[1])
    expect(strategyCovers(strategy, facts.mod正式)).toBe(want[2])
    expect(strategyCovers(strategy, facts.mod快照)).toBe(want[3])
  }

  it('全部开启：四类全隔离（默认）', () => {
    expectMatrix('all', [true, true, true, true])
  })
  it('全部关闭：四类全不隔离', () => {
    expectMatrix('none', [false, false, false, false])
  })
  it('仅隔离快照版：快照类隔离（含 mod 版快照本体）', () => {
    expectMatrix('snapshotOnly', [false, true, false, true])
  })
  it('仅隔离 mod 版：装加载器的版本隔离', () => {
    expectMatrix('modOnly', [false, false, true, true])
  })
  it('隔离快照版和 mod 版：二者之一即隔离', () => {
    expectMatrix('snapshotAndMod', [false, true, true, true])
  })
  it('策略枚举与校验', () => {
    expect(ISOLATION_STRATEGIES).toHaveLength(5)
    expect(isIsolationStrategy('all')).toBe(true)
    expect(isIsolationStrategy('follow')).toBe(false)
    expect(isIsolationStrategy('other')).toBe(false)
  })
})

describe('resolveIsolation（每版本覆盖）', () => {
  it('缺省 / follow：跟随全局策略', () => {
    expect(resolveIsolation({ globalStrategy: 'all', isSnapshot: false, isMod: false })).toBe(true)
    expect(resolveIsolation({ perVersion: 'follow', globalStrategy: 'none', isSnapshot: true, isMod: false })).toBe(false)
  })
  it('每版本覆盖：具体策略即生效，无视全局', () => {
    expect(
      resolveIsolation({ perVersion: 'none', globalStrategy: 'all', isSnapshot: true, isMod: true })
    ).toBe(false)
    expect(
      resolveIsolation({ perVersion: 'all', globalStrategy: 'none', isSnapshot: false, isMod: false })
    ).toBe(true)
  })
})

describe('deleteVersionArtifacts（本体自动清理）', () => {
  it('删除 versions/<id> 整目录；不存在时静默（force）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcl-delver-test-'))
    const versionDir = join(root, 'versions', '1.20.1')
    await mkdir(versionDir, { recursive: true })
    await writeFile(join(versionDir, '1.20.1.json'), '{}', 'utf8')
    await writeFile(join(versionDir, '1.20.1.jar'), 'jar', 'utf8')
    await writeFile(join(versionDir, '.install-ok'), 'ok\n', 'utf8')
    await deleteVersionArtifacts(root, '1.20.1')
    expect(existsSync(versionDir)).toBe(false)
    expect(existsSync(join(root, 'versions'))).toBe(true) // 兄弟目录不伤
    await deleteVersionArtifacts(root, '1.20.1') // 幂等
    await rm(root, { recursive: true, force: true })
  })
})

describe('updateInstance（isolation 覆盖）', () => {
  it('写入与重置 follow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcl-iso-meta-test-'))
    const { createInstance } = await import('../src')
    await createInstance(root, { id: 'main', name: '主实例' })
    await updateInstance(root, 'main', { isolation: 'snapshotOnly' })
    const { getInstance } = await import('../src')
    expect((await getInstance(root, 'main')).isolation).toBe('snapshotOnly')
    await updateInstance(root, 'main', { isolation: 'follow' })
    expect((await getInstance(root, 'main')).isolation).toBe('follow')
    await expect(updateInstance(root, 'main', { isolation: 'bogus' as never })).rejects.toThrow('isolation')
    await rm(root, { recursive: true, force: true })
  })
})
