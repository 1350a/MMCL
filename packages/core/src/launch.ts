import { delimiter as pathDelimiter, join } from 'node:path'
import { release as osRelease } from 'node:os'
import { VERSION } from './version-constants'
import { evaluateRules, type RuleContext } from './rules'
import { mavenPath } from './install'
import type { Account } from './account'
import type { Library, VersionJson } from './version'

/** 启动装配结果：可直接交给 gameProcess.spawn。 */
export interface LaunchSpec {
  javaPath: string
  /** JVM 参数（不含 java 可执行文件与主类）。 */
  jvmArgs: string[]
  mainClass: string
  /** 主类之后的游戏参数。 */
  gameArgs: string[]
  /** 游戏进程工作目录（实例目录）。 */
  cwd: string
}

/** authlib-injector 注入参数（外置登录）。 */
export interface JavaAgentOptions {
  /** authlib-injector.jar 绝对路径。 */
  jarPath: string
  /** 认证服务器 API 根（带尾斜杠）。 */
  apiRoot: string
  /** API 元数据响应原文的 base64（prefetched，避免游戏启动时再联网取）。 */
  prefetched?: string
}

export interface AssembleOptions {
  javaPath: string
  account: Account
  /** 游戏工作目录（实例目录）。 */
  gameDir: string
  /** launcher 根目录（libraries / assets 所在）。 */
  rootDir: string
  /** 离线场景的 accessToken，默认 '0'（Yggdrasil 账户使用账户内 token，此参数忽略）。 */
  accessToken?: string
  /** 特性开关（如 has_custom_resolution），用于 rules 评估。 */
  features?: Record<string, boolean>
  /** 用户附加 JVM 参数（如 -Xmx4G），放在最前。 */
  extraJvmArgs?: string[]
  /** 用户附加游戏参数，放在最后。 */
  extraGameArgs?: string[]
  /**
   * client jar 路径覆盖（继承版本场景：fabric 等子版本自身无 jar，用父版本 client jar）。
   * 缺省按 versions/<id>/<id>.jar 常规布局。
   */
  clientJarPath?: string
  /** authlib-injector 注入（外置登录时提供）。 */
  javaAgent?: JavaAgentOptions
  /** 覆盖平台检测（测试用）；version 缺省时 Windows 取 os.release()（如 10.0.19045）。 */
  os?: { name: string; arch: string; version?: string }
  launcherName?: string
  launcherVersion?: string
}

/** 由 rootDir 推断各默认路径（与 installVersion 的落盘布局一致）。 */
function defaultPaths(versionJson: VersionJson, rootDir: string, clientJarPath?: string) {
  const id = versionJson.id
  return {
    clientJar: clientJarPath ?? join(rootDir, 'versions', id, `${id}.jar`),
    nativesDir: join(rootDir, 'versions', id, 'natives'),
    librariesRoot: join(rootDir, 'libraries'),
    assetsRoot: join(rootDir, 'assets')
  }
}

/** library 的 classpath jar 相对路径（仅 artifact，natives classifier 不进 classpath）。 */
function libraryJarPath(lib: Library): string | undefined {
  const artifact = lib.downloads?.artifact
  if (artifact?.path) return artifact.path
  if (lib.url) return mavenPath(lib.name)
  return undefined
}

/** 对单条参数做模板变量替换；未知变量保留原样便于排查。 */
function substitute(token: string, vars: Record<string, string>): string {
  return token.replace(/\$\{(\w+)\}/g, (match, key: string) => vars[key] ?? match)
}

/** 组装启动参数（新式 arguments 与旧式 minecraftArguments 两种格式）。 */
export function assembleLaunch(versionJson: VersionJson, options: AssembleOptions): LaunchSpec {
  const osName = options.os?.name ?? (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux')
  const osVersion = options.os?.version ?? (osName === 'windows' ? osRelease() : undefined)
  const ctx: RuleContext = {
    os: { name: osName, version: osVersion, arch: options.os?.arch ?? process.arch },
    features: options.features ?? {}
  }

  const paths = defaultPaths(versionJson, options.rootDir, options.clientJarPath)
  const id = versionJson.id

  // classpath：rules 过滤后的 library jar（保持声明顺序）+ client jar
  const classpathEntries = versionJson.libraries
    .filter((lib) => evaluateRules(lib.rules, ctx))
    .map(libraryJarPath)
    .filter((p): p is string => p !== undefined)
    .map((p) => join(paths.librariesRoot, p))
  const classpath = [...classpathEntries, paths.clientJar].join(pathDelimiter)

  const assetsIndexId = versionJson.assetIndex?.id ?? versionJson.assets ?? ''
  // 认证相关变量按账户类型分支：Yggdrasil 用无连字符 uuid / 服务端 token / user_type=mojang
  // （authlib-injector 启动器技术规范）；离线账户保持 M1 已验收的行为不变。
  const yg = options.account.kind === 'yggdrasil' ? options.account : null
  const vars: Record<string, string> = {
    auth_player_name: options.account.name,
    auth_uuid: options.account.uuid,
    auth_access_token: yg ? yg.accessToken : (options.accessToken ?? '0'),
    auth_xuid: '0',
    auth_client_id: '0',
    user_type: yg ? 'mojang' : 'legacy',
    version_name: id,
    version_type: versionJson.type,
    game_directory: options.gameDir,
    assets_root: paths.assetsRoot,
    assets_index_name: assetsIndexId,
    user_properties: '{}',
    natives_directory: paths.nativesDir,
    launcher_name: options.launcherName ?? 'MCL',
    launcher_version: options.launcherVersion ?? VERSION,
    library_directory: paths.librariesRoot,
    classpath_separator: pathDelimiter,
    classpath
  }

  // JVM 参数
  const jvmArgs: string[] = [...(options.extraJvmArgs ?? [])]
  if (options.javaAgent) {
    jvmArgs.push(`-javaagent:${options.javaAgent.jarPath}=${options.javaAgent.apiRoot}`)
    if (options.javaAgent.prefetched) {
      jvmArgs.push(`-Dauthlibinjector.yggdrasil.prefetched=${options.javaAgent.prefetched}`)
    }
  }
  if (versionJson.logging?.client) {
    // logging.client.argument 形如 '-Dlog4j.configurationFile=${path}'
    const logConfigPath = join(paths.assetsRoot, 'log_configs', versionJson.logging.client.file.id)
    jvmArgs.push(substitute(versionJson.logging.client.argument, { path: logConfigPath }))
  }
  if (versionJson.arguments?.jvm) {
    for (const entry of versionJson.arguments.jvm) {
      if (typeof entry === 'string') {
        jvmArgs.push(substitute(entry, vars))
      } else if (evaluateRules(entry.rules, ctx)) {
        const values = Array.isArray(entry.value) ? entry.value : [entry.value]
        jvmArgs.push(...values.map((v) => substitute(v, vars)))
      }
    }
  } else {
    // 旧式版本：官方启动器的默认 JVM 参数
    jvmArgs.push(
      substitute('-Djava.library.path=${natives_directory}', vars),
      '-cp',
      classpath
    )
  }

  // 游戏参数
  const gameArgs: string[] = []
  if (versionJson.arguments?.game) {
    for (const entry of versionJson.arguments.game) {
      if (typeof entry === 'string') {
        gameArgs.push(substitute(entry, vars))
      } else if (evaluateRules(entry.rules, ctx)) {
        const values = Array.isArray(entry.value) ? entry.value : [entry.value]
        gameArgs.push(...values.map((v) => substitute(v, vars)))
      }
    }
  } else if (versionJson.minecraftArguments) {
    // 旧式：先按空格 tokenize 再逐个替换，避免含空格的路径被拆散
    gameArgs.push(...versionJson.minecraftArguments.split(' ').map((t) => substitute(t, vars)))
  }
  gameArgs.push(...(options.extraGameArgs ?? []))

  return {
    javaPath: options.javaPath,
    jvmArgs,
    mainClass: versionJson.mainClass,
    gameArgs,
    cwd: options.gameDir
  }
}
