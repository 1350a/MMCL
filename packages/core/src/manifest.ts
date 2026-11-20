import { createHash } from 'node:crypto'
import { ChecksumMismatchError, HttpError } from './errors'
import type { RuleBasedValue, VersionJson, VersionManifest, VersionManifestEntry } from './version'

export const DEFAULT_MANIFEST_URL =
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new HttpError(res.status, url)
  }
  return res.text()
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url)
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(`invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 拉取版本清单。默认官方 version_manifest_v2，可传镜像 URL（如 bmclapi）。 */
export async function fetchVersionManifest(url: string = DEFAULT_MANIFEST_URL): Promise<VersionManifest> {
  const manifest = await fetchJson<VersionManifest>(url)
  if (!manifest || !Array.isArray(manifest.versions)) {
    throw new Error(`invalid version manifest from ${url}`)
  }
  return manifest
}

/** 在清单中按 id 查找版本记录。 */
export function findVersionEntry(
  manifest: VersionManifest,
  id: string
): VersionManifestEntry | undefined {
  return manifest.versions.find((v) => v.id === id)
}

/** 拉取单个版本的 JSON。manifest v2 提供其 sha1 时传入以校验完整性。 */
export async function fetchVersionJson(url: string, expectedSha1?: string): Promise<VersionJson> {
  const text = await fetchText(url)
  if (expectedSha1) {
    const actual = createHash('sha1').update(text, 'utf8').digest('hex')
    if (actual !== expectedSha1.toLowerCase()) {
      throw new ChecksumMismatchError(url, expectedSha1, actual, 'sha1')
    }
  }
  try {
    return JSON.parse(text) as VersionJson
  } catch (err) {
    throw new Error(`invalid version JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 取 Maven 坐标的 group:artifact（忽略 version 与 classifier），用于继承合并去重。 */
function artifactKey(name: string): string {
  const parts = name.split(':')
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : name
}

/**
 * 合并 inheritsFrom 继承链：parent 为上游（父）版本 JSON。
 * 规则：标量字段（mainClass / assetIndex / assets / javaVersion / logging 等）子优先；
 * libraries 与 arguments 为父子拼接（子在前，group:artifact 相同的子条目覆盖父条目）。
 */
export function mergeVersionJson(child: VersionJson, parent: VersionJson): VersionJson {
  const libraries = [...child.libraries]
  const childKeys = new Set(child.libraries.map((l) => artifactKey(l.name)))
  for (const lib of parent.libraries) {
    if (!childKeys.has(artifactKey(lib.name))) libraries.push(lib)
  }

  const mergeArgs = (
    childList: (string | RuleBasedValue)[] | undefined,
    parentList: (string | RuleBasedValue)[] | undefined
  ): (string | RuleBasedValue)[] | undefined =>
    childList || parentList ? [...(parentList ?? []), ...(childList ?? [])] : undefined

  const minecraftArguments =
    child.minecraftArguments !== undefined || parent.minecraftArguments !== undefined
      ? [parent.minecraftArguments, child.minecraftArguments].filter(Boolean).join(' ')
      : undefined

  return {
    ...parent,
    ...child,
    libraries,
    arguments: {
      game: mergeArgs(child.arguments?.game, parent.arguments?.game) ?? [],
      jvm: mergeArgs(child.arguments?.jvm, parent.arguments?.jvm) ?? []
    },
    minecraftArguments
  }
}
