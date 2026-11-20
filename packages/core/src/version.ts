/**
 * Minecraft 版本元数据类型（依据 version_manifest_v2 与官方版本 JSON 实测结构，
 * 参考 1.16.5 新式 arguments 与 1.12.2 旧式 minecraftArguments 两种格式）。
 */

/** version_manifest_v2 中的单条版本记录。 */
export interface VersionManifestEntry {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha' | string
  url: string
  time: string
  releaseTime: string
  /** manifest v2 提供的版本 JSON sha1，下载时校验。 */
  sha1: string
  complianceLevel?: number
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionManifestEntry[]
}

/** 单个可下载文件描述（URL + sha1 + size），path 为相对根目录的 Maven 布局路径。 */
export interface DownloadInfo {
  path?: string
  sha1: string
  size: number
  url: string
}

export interface LibraryDownloads {
  artifact?: DownloadInfo
  /** natives classifier（如 natives-windows），key 为平台后缀。 */
  classifiers?: Record<string, DownloadInfo>
}

export interface RuleOs {
  name?: 'windows' | 'osx' | 'linux' | string
  /** 正则，匹配 os.version。 */
  version?: string
  arch?: string
}

export interface Rule {
  action: 'allow' | 'disallow'
  os?: RuleOs
  /** 特性开关（如 is_demo_user / has_custom_resolution），全部为真才匹配。 */
  features?: Record<string, boolean>
}

export interface Library {
  /** Maven 坐标 group:artifact:version[:classifier][@extension]。 */
  name: string
  downloads?: LibraryDownloads
  rules?: Rule[]
  /** 旧式版本（≈1.6 前）：库根 URL，按 name 拼 Maven 布局得到下载地址。 */
  url?: string
  /** 旧式版本：平台后缀 → classifier。 */
  natives?: Record<string, string>
  /** 旧式版本：natives 解压排除规则。 */
  extract?: { exclude?: string[] }
}

/** arguments 数组中带 rules 的对象形式，value 为 string 或 string[]。 */
export interface RuleBasedValue {
  rules: Rule[]
  value: string | string[]
}

export interface VersionArguments {
  game: (string | RuleBasedValue)[]
  jvm: (string | RuleBasedValue)[]
}

export interface VersionLogging {
  client?: {
    argument: string
    file: DownloadInfo & { id: string }
    type: string
  }
}

/** 版本 JSON（官方格式，不含 inheritsFrom 链上的父版本内容）。 */
export interface VersionJson {
  id: string
  type: string
  mainClass: string
  /** 新式参数（1.13+）。 */
  arguments?: VersionArguments
  /** 旧式参数（≤1.12），以空格分隔的模板字符串。 */
  minecraftArguments?: string
  downloads?: {
    client?: DownloadInfo
    client_mappings?: DownloadInfo
    server?: DownloadInfo
    server_mappings?: DownloadInfo
    windows_server?: DownloadInfo
    linux_server?: DownloadInfo
    [key: string]: DownloadInfo | undefined
  }
  assetIndex?: { id: string; sha1: string; size: number; totalSize: number; url: string }
  assets?: string
  javaVersion?: { component: string; majorVersion: number }
  libraries: Library[]
  logging?: VersionLogging
  /** 版本继承（mod 加载器场景），指向上游版本 id。 */
  inheritsFrom?: string
  releaseTime?: string
  time?: string
  minimumLauncherVersion?: number
  complianceLevel?: number
}
