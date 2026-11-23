import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, deleteInstance, ensureDefaultInstance, getInstance, isInstanceId, listInstances, updateInstance } from '../src'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

/** 每个用例独立的启动器根目录。 */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcl-instances-test-'))
  roots.push(root)
  return root
}

describe('isInstanceId', () => {
  it('目录名形态：字母/数字/._- 组合，禁 ..、分隔符、空串、超长', () => {
    expect(isInstanceId('main')).toBe(true)
    expect(isInstanceId('inst_1.2')).toBe(true)
    expect(isInstanceId('A9-x.y')).toBe(true)
    expect(isInstanceId('')).toBe(false)
    expect(isInstanceId('.hidden')).toBe(false)
    expect(isInstanceId('a..b')).toBe(false)
    expect(isInstanceId('a/b')).toBe(false)
    expect(isInstanceId('a\\b')).toBe(false)
    expect(isInstanceId(42)).toBe(false)
    expect(isInstanceId('a'.repeat(65))).toBe(false)
  })
})

describe('ensureDefaultInstance（默认实例迁移）', () => {
  it('无 instances 目录：创建 main 并落 instance.json；重复调用 no-op', async () => {
    const root = await makeRoot()
    const first = await ensureDefaultInstance(root)
    expect(first).toMatchObject({ id: 'main', name: '主实例' })
    expect(first.createdAt).toBeTruthy()
    const raw = JSON.parse(await readFile(join(root, 'instances', 'main', 'instance.json'), 'utf8'))
    expect(raw.id).toBe('main')
    const again = await ensureDefaultInstance(root)
    expect(again.createdAt).toBe(first.createdAt) // 不覆盖已有元数据
  })

  it('旧数据裸目录（无 instance.json）：补写元数据，不动实例内容', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'instances', 'main', 'mods'), { recursive: true })
    await writeFile(join(root, 'instances', 'main', 'mods', 'sodium.jar'), 'data')
    const meta = await ensureDefaultInstance(root)
    expect(meta).toMatchObject({ id: 'main', name: '主实例' })
    expect(await readFile(join(root, 'instances', 'main', 'mods', 'sodium.jar'), 'utf8')).toBe('data')
  })
})

describe('listInstances（扫描式注册表）', () => {
  it('meta 目录解析 + 旧裸目录合成 + 非目录跳过；空根返回空', async () => {
    const root = await makeRoot()
    expect(await listInstances(root)).toEqual([])

    await createInstance(root, { id: 'atlas', name: '图集服', versionId: '1.16.5' })
    await createInstance(root, { id: 'modern', name: '现代' })
    await mkdir(join(root, 'instances', 'legacy'), { recursive: true }) // 旧裸目录
    await writeFile(join(root, 'instances', 'afile.txt'), 'not a dir')

    const list = await listInstances(root)
    expect(list.map((i) => i.id)).toEqual(['atlas', 'legacy', 'modern']) // 无 main 时按 id 排
    expect(list.find((i) => i.id === 'legacy')).toMatchObject({ id: 'legacy', name: 'legacy' }) // 合成，不猜 name/version
    expect(list.find((i) => i.id === 'atlas')).toMatchObject({ name: '图集服', versionId: '1.16.5' })
    expect(list.some((i) => i.id === 'afile.txt')).toBe(false)
  })

  it('main 稳定排首', async () => {
    const root = await makeRoot()
    await createInstance(root, { id: 'zoo', name: 'z' })
    await createInstance(root, { id: 'main', name: '主实例' })
    await mkdir(join(root, 'instances', 'alpha'), { recursive: true })
    expect((await listInstances(root)).map((i) => i.id)).toEqual(['main', 'alpha', 'zoo'])
  })

  it('instance.json 损坏抛可读错误', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'instances', 'broken'), { recursive: true })
    await writeFile(join(root, 'instances', 'broken', 'instance.json'), '{ not json')
    await expect(listInstances(root)).rejects.toThrow(/broken.*损坏/)
  })
})

describe('createInstance / getInstance / updateInstance', () => {
  it('创建→读取→更新（绑版本/改名）→ 再读取', async () => {
    const root = await makeRoot()
    const created = await createInstance(root, { id: 'atlas', name: '图集服' })
    expect(created.versionId).toBeUndefined()
    expect((await getInstance(root, 'atlas')).name).toBe('图集服')

    const updated = await updateInstance(root, 'atlas', { versionId: '1.16.5', name: '图集服 v2' })
    expect(updated).toMatchObject({ id: 'atlas', name: '图集服 v2', versionId: '1.16.5' })
    expect((await getInstance(root, 'atlas')).versionId).toBe('1.16.5')
  })

  it('拒绝：重复 id / 非法 id / 缺 name / 空 versionId / 更新未知实例', async () => {
    const root = await makeRoot()
    await createInstance(root, { id: 'atlas', name: '图集服' })
    await expect(createInstance(root, { id: 'atlas', name: 'x' })).rejects.toThrow(/已存在/)
    await expect(createInstance(root, { id: 'bad id!', name: 'x' })).rejects.toThrow(/实例 id 非法/)
    await expect(createInstance(root, { id: 'a..b', name: 'x' })).rejects.toThrow(/实例 id 非法/)
    await expect(createInstance(root, { id: 'ok', name: '' })).rejects.toThrow(/name/)
    await expect(createInstance(root, { id: 'ok2', name: 'x', versionId: '' })).rejects.toThrow(/versionId/)
    await expect(getInstance(root, 'nope')).rejects.toThrow(/实例 nope 不存在/)
    await expect(updateInstance(root, 'nope', { versionId: '1.16.5' })).rejects.toThrow(/实例 nope 不存在/)
    await expect(updateInstance(root, 'atlas', { versionId: '' })).rejects.toThrow(/versionId/)
  })

  it('instance.json 的 id 与目录名不一致：读取即拒', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'instances', 'liar'), { recursive: true })
    await writeFile(join(root, 'instances', 'liar', 'instance.json'), JSON.stringify({ id: 'other', name: 'x' }))
    await expect(getInstance(root, 'liar')).rejects.toThrow(/与目录名（liar）不一致/)
  })
})

describe('deleteInstance（不可逆，调用方负责确认）', () => {
  it('删除后目录与内容消失、清单不再含；删除不存在/非法 id 拒绝', async () => {
    const root = await makeRoot()
    await createInstance(root, { id: 'doomed', name: '要删的', versionId: '1.16.5' })
    await mkdir(join(root, 'instances', 'doomed', 'saves'), { recursive: true })
    await writeFile(join(root, 'instances', 'doomed', 'saves', 'world'), 'data')

    await deleteInstance(root, 'doomed')
    expect((await listInstances(root)).some((i) => i.id === 'doomed')).toBe(false)
    await expect(getInstance(root, 'doomed')).rejects.toThrow(/实例 doomed 不存在/)

    await expect(deleteInstance(root, 'doomed')).rejects.toThrow(/实例 doomed 不存在/)
    await expect(deleteInstance(root, '../escape')).rejects.toThrow(/非法实例 id/)
    // main 仍在（删别的实例不影响）
    await ensureDefaultInstance(root)
    expect((await listInstances(root)).map((i) => i.id)).toContain('main')
  })
})
