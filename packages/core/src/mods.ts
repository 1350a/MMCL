import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

/** mods 目录管理（游戏工作目录下的 mods/，fabric 原生读取）。 */

export interface ModFileInfo {
  filename: string
  sizeBytes: number
}

/** 列出实例 mods 目录下的 .jar（目录不存在视为空）。 */
export async function listMods(gameDir: string): Promise<ModFileInfo[]> {
  const modsDir = join(gameDir, 'mods')
  const entries = await fs.readdir(modsDir, { withFileTypes: true }).catch(() => [])
  const files: ModFileInfo[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jar')) continue
    const st = await fs.stat(join(modsDir, e.name)).catch(() => null)
    files.push({ filename: e.name, sizeBytes: st?.size ?? 0 })
  }
  return files.sort((a, b) => a.filename.localeCompare(b.filename))
}

/** 校验 mods 文件名：只允许纯文件名（防路径穿越写出到 mods 目录之外）。 */
function assertModFilename(filename: string): void {
  if (!filename.endsWith('.jar') || basename(filename) !== filename || isAbsolute(filename)) {
    throw new Error(`非法 mod 文件名：${filename}`)
  }
}

/** 删除 mods 目录下的一个 mod（不存在时报错）。 */
export async function removeMod(gameDir: string, filename: string): Promise<void> {
  assertModFilename(filename)
  const dest = join(gameDir, 'mods', filename)
  await fs.rm(dest).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') throw new Error(`mods 目录下没有 ${filename}`)
    throw err
  })
}

/** 从本地路径安装 mod：复制 jar 到 mods/（同名覆盖）。返回落盘文件名。 */
export async function installLocalMod(gameDir: string, jarPath: string): Promise<string> {
  if (typeof jarPath !== 'string' || !jarPath.toLowerCase().endsWith('.jar')) {
    throw new Error(`mod 路径需指向 .jar 文件：${jarPath}`)
  }
  const filename = basename(jarPath)
  const src = await fs.stat(jarPath).catch(() => null)
  if (!src?.isFile()) {
    throw new Error(`找不到 mod 文件：${jarPath}`)
  }
  await fs.mkdir(join(gameDir, 'mods'), { recursive: true })
  await fs.copyFile(jarPath, join(gameDir, 'mods', filename))
  return filename
}
