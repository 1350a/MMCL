import { promises as fs } from 'node:fs'

/** AI 接入配置（明文存储于 mmcl.json，与旧 settings.json 一致）。 */
export interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 更新检查四选（UI-DESIGN.md §5；更新服务器未实装，仅落地设置项）。 */
export type UpdateMode = 'auto' | 'notify' | 'notifyImportant' | 'off'

/** UI 偏好（外观类设置暂存）。 */
export interface UiPrefs {
  /** 侧栏隐藏（设置页开关）。 */
  sidebarHidden?: boolean
  /** 自定义背景图绝对路径（空/缺省用内置背景）。 */
  backgroundPath?: string
}

/** 全局配置：.mmcl\mmcl.json（UI-DESIGN.md §3/§4）。 */
export interface MmclConfig {
  /** 上次使用的游戏根（启动优先复用；目录消失则兜底新建）。 */
  lastGameRoot?: string
  /** 上次选中的版本本体 id（进主页恢复选择）。 */
  lastVersionId?: string
  /** 手动配置的 java.exe 路径（空 = 自动探测 PATH/JAVA_HOME）。 */
  javaPath?: string
  /** 本启动器实例的 clientToken（首次登录时生成，长期复用）。 */
  clientToken?: string
  /** AI 接入配置。 */
  ai?: AiConfig
  /** 更新检查模式（默认提醒更新）。 */
  updates?: UpdateMode
  /** 删除版本时本体（versions/<id>）无引用自动清理（默认开）。 */
  autoCleanupVersions?: boolean
  /** 下载源偏好（官方失败/超时时引导切换 BMCLAPI，不静默）。 */
  downloadSource?: 'official' | 'bmclapi'
  /** UI 偏好。 */
  ui?: UiPrefs
}

/** 默认配置（损坏/缺失时以此重置）。 */
export function defaultConfig(): MmclConfig {
  return {
    updates: 'notify',
    autoCleanupVersions: true,
    downloadSource: 'official'
  }
}

/**
 * 读取全局配置：文件缺失返回默认值；JSON 损坏按「损坏→重置默认」处理，
 * 尽力把默认值写回文件后继续（UI-DESIGN.md §5 步骤 1）。
 */
export async function loadConfig(path: string): Promise<MmclConfig> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch {
    return defaultConfig() // 不存在：默认值（不落盘，等首次保存）
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const reset = defaultConfig()
    await saveConfig(path, reset).catch(() => undefined) // 重置失败不阻塞启动
    return reset
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const reset = defaultConfig()
    await saveConfig(path, reset).catch(() => undefined)
    return reset
  }
  // 与默认值合并：显式字段优先，缺省字段补默认
  return { ...defaultConfig(), ...(parsed as Partial<MmclConfig>) }
}

/** 保存全局配置（目录不存在则创建）。 */
export async function saveConfig(path: string, config: MmclConfig): Promise<void> {
  const { dirname } = await import('node:path')
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(config, null, 2))
}
