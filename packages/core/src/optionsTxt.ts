import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * options.txt（游戏设置，位于实例目录）读写。格式为 `key:value` 行（value 可含冒号，
 * 如 key_bind 的按键序列），按首冒号切分。原文件无注释，读写保持原有行序，新 key 追加。
 */

/** 读取 options.txt 为有序键值表（文件不存在返回空表）。 */
export async function readOptionsTxt(gameDir: string): Promise<Array<{ key: string; value: string }>> {
  let raw: string
  try {
    raw = await fs.readFile(join(gameDir, 'options.txt'), 'utf8')
  } catch {
    return []
  }
  const entries: Array<{ key: string; value: string }> = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue // 无冒号或空 key 的异常行跳过
    entries.push({ key: trimmed.slice(0, idx), value: trimmed.slice(idx + 1) })
  }
  return entries
}

/** 写入若干选项（合并进现有文件：已有 key 原位更新，新 key 追加到末尾）。 */
export async function writeOptionsTxt(
  gameDir: string,
  entries: Record<string, string>
): Promise<Array<{ key: string; value: string }>> {
  const keys = Object.keys(entries)
  for (const k of keys) {
    if (!/^[\w.+-]+$/.test(k)) {
      throw new Error(`非法 options.txt 键名：${k}`)
    }
  }
  const existing = await readOptionsTxt(gameDir)
  const map = new Map(existing.map((e) => [e.key, e.value]))
  for (const k of keys) map.set(k, entries[k])
  await fs.mkdir(gameDir, { recursive: true })
  await fs.writeFile(join(gameDir, 'options.txt'), [...map].map(([k, v]) => `${k}:${v}`).join('\n') + '\n')
  return [...map].map(([key, value]) => ({ key, value }))
}
