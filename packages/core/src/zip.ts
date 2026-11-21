import AdmZip from 'adm-zip'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface ExtractZipOptions {
  /** 跳过以此前缀开头的条目（如 META-INF/）。 */
  exclude?: string[]
  /** 解压进度：已写条目数 / 总条目数。 */
  onProgress?: (done: number, total: number) => void
}

/** 通用 zip 解压：跳过目录与 exclude 前缀，拒绝 .. 条目（防 zip-slip），逐条写盘。 */
export async function extractZip(zipPath: string, destDir: string, options: ExtractZipOptions = {}): Promise<void> {
  const { exclude = [], onProgress } = options
  await fs.mkdir(destDir, { recursive: true })
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries().filter((e) => !e.isDirectory)
  let done = 0
  for (const entry of entries) {
    const name = entry.entryName
    if (exclude.some((prefix) => name.startsWith(prefix))) continue
    const segments = name.split('/')
    // zip-slip 防护：任何一段为 .. 都拒绝
    if (segments.some((s) => s === '..')) continue
    const target = join(destDir, ...segments)
    await fs.mkdir(join(target, '..'), { recursive: true })
    await fs.writeFile(target, entry.getData())
    done++
    onProgress?.(done, entries.length)
  }
}
