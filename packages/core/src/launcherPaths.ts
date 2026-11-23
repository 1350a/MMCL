import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 启动器自身数据目录：%USERPROFILE%\.mmcl（UI-DESIGN.md §4）。 */
export function resolveMmclDir(homeDir: string): string {
  return join(homeDir, '.mmcl')
}

/** AI 脚本工作区：恒为 .mmcl\workspace，永不指向游戏目录（防污染）。 */
export function resolveWorkspaceDir(mmclDir: string): string {
  return join(mmclDir, 'workspace')
}

/** 官方启动器默认游戏根候选：%APPDATA%\.minecraft。 */
export function officialGameRoot(appDataDir: string): string {
  return join(appDataDir, '.minecraft')
}

/** 兜底游戏根：.mmcl\.minecraft（无官启目录或记忆路径失效时新建）。 */
export function fallbackGameRoot(mmclDir: string): string {
  return join(mmclDir, '.minecraft')
}

export type GameRootSource = 'memory' | 'official' | 'fallback'

export interface GameRootResolution {
  root: string
  source: GameRootSource
  /** 命中记忆但目录已消失时的提示语（日志/通知用）。 */
  warning?: string
}

/**
 * 游戏根解析（UI-DESIGN.md §4/§5 步骤 2）：
 * 记忆的上次路径存在 → 直接用；消失 → 警告 + 兜底新建 .mmcl\.minecraft；
 * 首次（无记忆）→ 探测官启目录，存在即用；否则新建兜底目录。
 */
export function resolveGameRoot(options: {
  mmclDir: string
  lastGameRoot?: string
  officialGameRoot?: string
  /** 目录存在性判断（默认 existsSync；测试注入）。 */
  exists?: (path: string) => boolean
}): GameRootResolution {
  const exists = options.exists ?? existsSync
  const fallback = fallbackGameRoot(options.mmclDir)
  if (options.lastGameRoot && options.lastGameRoot.trim() !== '') {
    if (exists(options.lastGameRoot)) return { root: options.lastGameRoot, source: 'memory' }
    return {
      root: fallback,
      source: 'fallback',
      warning: `上次游戏根目录已不存在：${options.lastGameRoot}（改用 ${fallback}）`
    }
  }
  if (options.officialGameRoot && exists(options.officialGameRoot)) {
    return { root: options.officialGameRoot, source: 'official' }
  }
  return { root: fallback, source: 'fallback' }
}

/** 游戏根标准子目录（缺什么补建什么；mkdir recursive 幂等）。 */
const GAME_ROOT_DIRS = [
  'versions',
  'libraries',
  'assets',
  'instances',
  'saves',
  'screenshots',
  'logs',
  'mods',
  'config'
] as const

/** 确保游戏根及其标准子目录存在（官方目录存在即可用，缺什么文件夹补建什么）。 */
export async function ensureGameDirs(gameRoot: string): Promise<void> {
  const { promises: fs } = await import('node:fs')
  await Promise.all(GAME_ROOT_DIRS.map((d) => fs.mkdir(join(gameRoot, d), { recursive: true })))
}

/**
 * 校验目录可写：以写探测文件并删除为准（Windows 上 access(W_OK) 对只读属性/ACL 不可靠）。
 * 目录不存在时先递归创建（用户选的新游戏根路径允许尚不存在）。
 */
export async function assertDirWritable(dir: string): Promise<void> {
  const { promises: fs } = await import('node:fs')
  try {
    await fs.mkdir(dir, { recursive: true })
    const probe = join(dir, `.mmcl-write-probe-${process.pid}-${Date.now()}`)
    await fs.writeFile(probe, 'probe')
    await fs.rm(probe, { force: true })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`目录不可写：${dir}（${detail}）`)
  }
}
