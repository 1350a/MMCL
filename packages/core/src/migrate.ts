import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { saveConfig } from './config'
import type { MmclConfig } from './config'

export interface LegacyMigrationReport {
  /** 已搬迁条目（相对 legacyRoot 的名字 → 目标）。 */
  moved: string[]
  /** 跳过（源不存在或目标已存在）。 */
  skipped: string[]
  /** 失败条目（源保留原地，不阻塞其余条目）。 */
  failed: Array<{ item: string; error: string }>
}

/** 目录合并搬迁：把 srcDir 的每个子项移入 destDir，同名跳过（保留目标）。 */
async function mergeDir(srcDir: string, destDir: string, item: string, report: LegacyMigrationReport): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true })
  } catch {
    report.skipped.push(item) // 源目录不存在/不可读
    return
  }
  await fs.mkdir(destDir, { recursive: true })
  for (const entry of entries) {
    const target = join(destDir, entry.name)
    if (existsSync(target)) {
      report.skipped.push(`${item}/${entry.name}`)
      continue
    }
    try {
      await fs.rename(join(srcDir, entry.name), target)
      report.moved.push(`${item}/${entry.name}`)
    } catch (err) {
      // rename 失败（跨卷/占用）退回复制 + 删除
      try {
        await fs.cp(join(srcDir, entry.name), target, { recursive: true })
        await fs.rm(join(srcDir, entry.name), { recursive: true, force: true })
        report.moved.push(`${item}/${entry.name}`)
      } catch (err2) {
        report.failed.push({ item: `${item}/${entry.name}`, error: (err2 as Error).message })
      }
    }
  }
}

/** 单文件搬迁：源不存在或目标已存在即跳过。 */
async function moveFile(src: string, dest: string, item: string, report: LegacyMigrationReport): Promise<void> {
  if (!existsSync(src)) {
    report.skipped.push(item)
    return
  }
  if (existsSync(dest)) {
    report.skipped.push(item)
    return
  }
  await fs.mkdir(dirname(dest), { recursive: true }) // 目标目录不存在则创建（rename/copy 不建父目录）
  try {
    await fs.rename(src, dest)
    report.moved.push(item)
  } catch (err) {
    try {
      await fs.copyFile(src, dest)
      await fs.rm(src, { force: true })
      report.moved.push(item)
    } catch (err2) {
      report.failed.push({ item, error: (err2 as Error).message })
    }
  }
}

/**
 * 遗留数据迁移（UI 重构 C3）：旧 userData 布局 → .mmcl（启动器数据）+ 游戏根（游戏数据）。
 * 每次启动幂等执行：源不存在/目标已存在即跳过，源为空时整体零操作。
 * 旧 settings.json 特殊处理：无 mmcl.json 时把 javaPath/clientToken/ai 并入新配置落盘。
 */
export async function migrateLegacyData(options: {
  legacyRoot: string
  mmclDir: string
  gameRoot: string
  configPath: string
  /** 读到的当前配置（迁移 settings.json 后更新返回）。 */
  config: MmclConfig
}): Promise<{ report: LegacyMigrationReport; config: MmclConfig }> {
  const { legacyRoot, mmclDir, gameRoot, configPath } = options
  const report: LegacyMigrationReport = { moved: [], skipped: [], failed: [] }
  let config = options.config

  // settings.json → mmcl.json：旧字段按需并入（mmcl.json 可能已由部分迁移建出，
  // 只补缺失字段；吸收后删除旧文件，保证一次性）
  const legacySettingsPath = join(legacyRoot, 'settings.json')
  if (existsSync(legacySettingsPath)) {
    try {
      const legacy = JSON.parse(await fs.readFile(legacySettingsPath, 'utf8')) as {
        javaPath?: string
        clientToken?: string
        ai?: MmclConfig['ai']
      }
      let changed = false
      if (legacy.javaPath && !config.javaPath) {
        config = { ...config, javaPath: legacy.javaPath }
        changed = true
      }
      if (legacy.clientToken && !config.clientToken) {
        config = { ...config, clientToken: legacy.clientToken }
        changed = true
      }
      if (legacy.ai && !config.ai) {
        config = { ...config, ai: legacy.ai }
        changed = true
      }
      if (changed) await saveConfig(configPath, config)
      await fs.rm(legacySettingsPath, { force: true })
      report.moved.push('settings.json → mmcl.json')
    } catch (err) {
      report.failed.push({ item: 'settings.json → mmcl.json', error: (err as Error).message })
    }
  }

  // 启动器数据 → .mmcl
  await moveFile(join(legacyRoot, 'accounts.json'), join(mmclDir, 'accounts.json'), 'accounts.json', report)
  await moveFile(join(legacyRoot, 'ai-session.json'), join(mmclDir, 'ai-session.json'), 'ai-session.json', report)
  // authlib-injector 是目录（内含 jar 与 .part 残片），整目录合并搬
  await mergeDir(join(legacyRoot, 'authlib-injector'), join(mmclDir, 'authlib-injector'), 'authlib-injector', report)
  await mergeDir(join(legacyRoot, 'extensions'), join(mmclDir, 'extensions'), 'extensions', report)
  await mergeDir(join(legacyRoot, 'runtimes'), join(mmclDir, 'runtimes'), 'runtimes', report)

  // 游戏数据 → 游戏根
  await mergeDir(join(legacyRoot, 'versions'), join(gameRoot, 'versions'), 'versions', report)
  await mergeDir(join(legacyRoot, 'libraries'), join(gameRoot, 'libraries'), 'libraries', report)
  await mergeDir(join(legacyRoot, 'assets'), join(gameRoot, 'assets'), 'assets', report)
  await mergeDir(join(legacyRoot, 'instances'), join(gameRoot, 'instances'), 'instances', report)

  return { report, config }
}
