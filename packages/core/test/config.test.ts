import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, loadConfig, saveConfig } from '../src'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

/** 每个用例独立的临时目录。 */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcl-config-test-'))
  roots.push(root)
  return root
}

describe('loadConfig / saveConfig（mmcl.json）', () => {
  it('文件缺失：返回默认值且不落盘', async () => {
    const root = await makeRoot()
    const config = await loadConfig(join(root, 'mmcl.json'))
    expect(config).toEqual(defaultConfig())
    await expect(readFile(join(root, 'mmcl.json'), 'utf8')).rejects.toThrow()
  })

  it('损坏 JSON：重置为默认值并写回文件（损坏→重置默认，继续）', async () => {
    const root = await makeRoot()
    const path = join(root, 'mmcl.json')
    await writeFile(path, '{ 这不是 JSON', 'utf8')
    const config = await loadConfig(path)
    expect(config).toEqual(defaultConfig())
    const raw = JSON.parse(await readFile(path, 'utf8'))
    expect(raw.updates).toBe('notify')
  })

  it('合法 JSON：缺省字段补默认，显式字段优先', async () => {
    const root = await makeRoot()
    const path = join(root, 'mmcl.json')
    await writeFile(
      path,
      JSON.stringify({ lastGameRoot: 'D:/games/mc', updates: 'off', ai: { baseUrl: 'x', apiKey: 'k', model: 'm' } }),
      'utf8'
    )
    const config = await loadConfig(path)
    expect(config.lastGameRoot).toBe('D:/games/mc')
    expect(config.updates).toBe('off')
    expect(config.autoCleanupVersions).toBe(true) // 缺省补默认
    expect(config.ai?.apiKey).toBe('k')
  })

  it('非对象 JSON（数组/字面量）：重置为默认值', async () => {
    const root = await makeRoot()
    const path = join(root, 'mmcl.json')
    await writeFile(path, '[1,2,3]', 'utf8')
    expect(await loadConfig(path)).toEqual(defaultConfig())
  })

  it('saveConfig：roundtrip 保留全部字段（含可选 undefined 字段不落盘）', async () => {
    const root = await makeRoot()
    const path = join(root, 'sub', 'mmcl.json')
    await saveConfig(path, { javaPath: 'C:/jdk/bin/java.exe', ui: { sidebarHidden: true } })
    const raw = JSON.parse(await readFile(path, 'utf8'))
    expect(raw.javaPath).toBe('C:/jdk/bin/java.exe')
    expect(raw.ui.sidebarHidden).toBe(true)
    expect(raw.lastVersionId).toBeUndefined()
    expect(JSON.stringify(raw)).not.toContain('lastVersionId')
  })
})
