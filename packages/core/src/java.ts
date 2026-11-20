import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:process'
import { JavaNotFoundError, JavaVersionMismatchError } from './errors'
import type { VersionJson } from './version'

export interface JavaInfo {
  /** java 可执行文件的绝对路径或 PATH 解析结果。 */
  path: string
  /** 主版本号（1.8.0_381 → 8，17.0.9 → 17）。 */
  majorVersion: number
  /** -version 输出的原始版本串。 */
  raw: string
}

/** Windows 下 java 可执行文件名。 */
const JAVA_EXE = platform === 'win32' ? 'java.exe' : 'java'

/** 解析 `java -version` 输出（stderr）中的主版本号。 */
export function parseJavaVersionText(text: string): { majorVersion: number; raw: string } | undefined {
  const match = /version "([^"]+)"/.exec(text)
  if (!match) return undefined
  const raw = match[1]
  const parts = raw.split(/[._-]/)
  const first = Number(parts[0])
  // 旧命名 1.8.0_x → 8；新命名 17.0.9 → 17
  const majorVersion = raw.startsWith('1.') && first === 1 ? Number(parts[1]) : first
  if (!Number.isFinite(majorVersion)) return undefined
  return { majorVersion, raw }
}

/** 运行 `<java> -version` 解析版本（输出去 stderr）。 */
function probeJava(javaPath: string): Promise<JavaInfo> {
  return new Promise((resolve, reject) => {
    execFile(javaPath, ['-version'], { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(err)
        return
      }
      const parsed = parseJavaVersionText(stderr)
      if (!parsed) {
        reject(new Error(`cannot parse java -version output: ${stderr.slice(0, 200)}`))
        return
      }
      resolve({ path: javaPath, majorVersion: parsed.majorVersion, raw: parsed.raw })
    })
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 探测可用的 Java：
 * 1. 显式配置的路径（文件存在才用）；
 * 2. JAVA_HOME/bin/java；
 * 3. PATH 上的 java。
 * 全部失败抛 JavaNotFoundError。
 */
export async function detectJava(configuredPath?: string): Promise<JavaInfo> {
  const tried: string[] = []
  if (configuredPath) {
    tried.push(configuredPath)
    if (await exists(configuredPath)) {
      return probeJava(configuredPath)
    }
  }
  const javaHome = process.env.JAVA_HOME
  if (javaHome) {
    const candidate = join(javaHome, 'bin', JAVA_EXE)
    tried.push(candidate)
    if (await exists(candidate)) {
      return probeJava(candidate)
    }
  }
  tried.push('java')
  return probeJava('java').catch((err) => {
    throw err instanceof Error && err.message.includes('ENOENT') ? new JavaNotFoundError(tried) : err
  })
}

/** 校验 Java 版本是否满足版本 JSON 要求（javaVersion.majorVersion）。 */
export function assertJavaCompatible(java: JavaInfo, versionJson: VersionJson): void {
  const required = versionJson.javaVersion?.majorVersion
  if (required !== undefined && java.majorVersion < required) {
    throw new JavaVersionMismatchError(java.majorVersion, required)
  }
}
