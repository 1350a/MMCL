import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, loadConfig, migrateLegacyData } from '../src'
import type { MmclConfig } from '../src'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

/** 每个用例独立的临时目录组。 */
async function makeRoots(): Promise<{ legacyRoot: string; mmclDir: string; gameRoot: string; configPath: string }> {
  const base = await mkdtemp(join(tmpdir(), 'mcl-migrate-test-'))
  roots.push(base)
  const legacyRoot = join(base, 'legacy-userdata')
  const mmclDir = join(base, 'mmcl')
  const gameRoot = join(base, 'game-root')
  await mkdir(legacyRoot, { recursive: true })
  return { legacyRoot, mmclDir, gameRoot, configPath: join(mmclDir, 'mmcl.json') }
}

describe('migrateLegacyData（遗留 userData → .mmcl + 游戏根）', () => {
  it('源为空：整体零操作（幂等基础）', async () => {
    const { legacyRoot, mmclDir, gameRoot, configPath } = await makeRoots()
    const config = defaultConfig()
    const { report } = await migrateLegacyData({ legacyRoot, mmclDir, gameRoot, configPath, config })
    expect(report.moved).toEqual([])
    expect(report.failed).toEqual([])
    expect(existsSync(mmclDir)).toBe(false)
  })

  it('文件搬迁：accounts/ai-session → .mmcl；authlib-injector 目录整体合并', async () => {
    const { legacyRoot, mmclDir, gameRoot, configPath } = await makeRoots()
    await writeFile(join(legacyRoot, 'accounts.json'), '[]', 'utf8')
    await writeFile(join(legacyRoot, 'ai-session.json'), '{"messages":[]}', 'utf8')
    await mkdir(join(legacyRoot, 'authlib-injector'), { recursive: true })
    await writeFile(join(legacyRoot, 'authlib-injector', 'authlib-injector.jar'), 'jar-bytes', 'utf8')
    const { report } = await migrateLegacyData({
      legacyRoot,
      mmclDir,
      gameRoot,
      configPath,
      config: defaultConfig()
    })
    expect(report.moved).toContain('accounts.json')
    expect(report.moved).toContain('ai-session.json')
    expect(report.moved).toContain('authlib-injector/authlib-injector.jar')
    expect(await readFile(join(mmclDir, 'accounts.json'), 'utf8')).toBe('[]')
    expect(await readFile(join(mmclDir, 'authlib-injector', 'authlib-injector.jar'), 'utf8')).toBe('jar-bytes')
    expect(existsSync(join(legacyRoot, 'accounts.json'))).toBe(false)
    expect(existsSync(join(gameRoot, 'accounts.json'))).toBe(false) // 不进游戏根
  })

  it('目录合并搬迁：versions/instances 子项进游戏根、extensions/runtimes 进 .mmcl，目标同名跳过', async () => {
    const { legacyRoot, mmclDir, gameRoot, configPath } = await makeRoots()
    await mkdir(join(legacyRoot, 'versions', '1.20.1'), { recursive: true })
    await mkdir(join(legacyRoot, 'instances', 'main'), { recursive: true })
    await mkdir(join(legacyRoot, 'extensions', 'demo'), { recursive: true })
    await mkdir(join(gameRoot, 'versions', '1.20.1'), { recursive: true }) // 目标已存在（官启目录常见）
    await writeFile(join(legacyRoot, 'versions', '1.20.1', '1.20.1.json'), '{}', 'utf8')
    await writeFile(join(gameRoot, 'versions', '1.20.1', 'keep.txt'), 'official', 'utf8')

    const { report } = await migrateLegacyData({
      legacyRoot,
      mmclDir,
      gameRoot,
      configPath,
      config: defaultConfig()
    })
    expect(report.moved).toContain('instances/main')
    expect(report.moved).toContain('extensions/demo')
    expect(report.skipped).toContain('versions/1.20.1') // 整目录同名跳过，不覆盖
    expect(await readFile(join(gameRoot, 'versions', '1.20.1', 'keep.txt'), 'utf8')).toBe('official')
    expect(existsSync(join(gameRoot, 'instances', 'main'))).toBe(true)
    expect(existsSync(join(mmclDir, 'extensions', 'demo'))).toBe(true)
  })

  it('settings.json → mmcl.json：旧字段按缺补入（含 mmcl.json 已存在场景）；吸收后删旧文件', async () => {
    const { legacyRoot, mmclDir, gameRoot, configPath } = await makeRoots()
    await writeFile(
      join(legacyRoot, 'settings.json'),
      JSON.stringify({ javaPath: 'C:/jdk/java.exe', clientToken: 'tok', ai: { baseUrl: 'b', apiKey: 'k', model: 'm' } }),
      'utf8'
    )
    const first = await migrateLegacyData({ legacyRoot, mmclDir, gameRoot, configPath, config: defaultConfig() })
    expect(first.report.moved).toContain('settings.json → mmcl.json')
    expect(first.config.javaPath).toBe('C:/jdk/java.exe')
    expect(first.config.clientToken).toBe('tok')
    expect(first.config.ai?.apiKey).toBe('k')
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as MmclConfig
    expect(saved.updates).toBe('notify') // 默认值合并落盘
    expect(existsSync(join(legacyRoot, 'settings.json'))).toBe(false)

    // 幂等：第二次运行不再吸收（settings.json 已删）
    const second = await migrateLegacyData({ legacyRoot, mmclDir, gameRoot, configPath, config: defaultConfig() })
    expect(second.report.moved).not.toContain('settings.json → mmcl.json')
    expect(second.config.javaPath).toBeUndefined() // 传入的是新 config，不受旧文件影响
  })

  it('部分迁移现场：mmcl.json 已存在但缺 AI 字段 → settings.json 字段补缺并入', async () => {
    const { legacyRoot, mmclDir, gameRoot, configPath } = await makeRoots()
    // 现场复刻：首次迁移已建 mmcl.json（仅 lastGameRoot），settings.json 因旧实现被跳过
    await mkdir(mmclDir, { recursive: true })
    await writeFile(
      configPath,
      JSON.stringify({ lastGameRoot: 'D:/games/mc', updates: 'notify', autoCleanupVersions: true, downloadSource: 'official' }),
      'utf8'
    )
    await writeFile(
      join(legacyRoot, 'settings.json'),
      JSON.stringify({ clientToken: 'tok', ai: { baseUrl: 'b', apiKey: 'k', model: 'm' } }),
      'utf8'
    )
    const current = await loadConfig(configPath) // 真实流程：bootstrap 先读盘上配置再迁移
    const { config } = await migrateLegacyData({ legacyRoot, mmclDir, gameRoot, configPath, config: current })
    expect(config.clientToken).toBe('tok')
    expect(config.ai?.apiKey).toBe('k')
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as MmclConfig
    expect(saved.ai?.apiKey).toBe('k')
    expect(saved.lastGameRoot).toBe('D:/games/mc') // 已有字段不被吸收覆盖
    expect(existsSync(join(legacyRoot, 'settings.json'))).toBe(false)
  })

  it('完整幂等：同输入跑两遍，第二遍零 moved', async () => {
    const { legacyRoot, mmclDir, gameRoot, configPath } = await makeRoots()
    await mkdir(join(legacyRoot, 'versions', '1.16.5'), { recursive: true })
    await mkdir(join(legacyRoot, 'instances', 'main'), { recursive: true })
    await writeFile(join(legacyRoot, 'accounts.json'), '[]', 'utf8')
    const pass1 = await migrateLegacyData({ legacyRoot, mmclDir, gameRoot, configPath, config: defaultConfig() })
    expect(pass1.report.moved.length).toBeGreaterThan(0)
    const pass2 = await migrateLegacyData({ legacyRoot, mmclDir, gameRoot, configPath, config: defaultConfig() })
    expect(pass2.report.moved).toEqual([])
    expect(pass2.report.failed).toEqual([])
    expect((await readdir(gameRoot)).sort()).toContain('instances')
  })
})
