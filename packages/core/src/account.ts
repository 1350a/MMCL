import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { InvalidPlayerNameError } from './errors'

/** 玩家名规则：3-16 位字母/数字/下划线（仅离线账户强制，Yggdrasil 名字以服务器为准）。 */
export const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/

/**
 * 离线玩家 UUID：对 `OfflinePlayer:<name>` 的 UTF-8 字节取 MD5，
 * 置 version=3、IETF variant（等价于 Java UUID.nameUUIDFromBytes）。
 * 玩家名大小写敏感。
 */
export function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30
  hash[8] = (hash[8] & 0x3f) | 0x80
  const x = hash.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

/** 校验离线玩家名，非法时抛出 InvalidPlayerNameError。 */
export function validatePlayerName(name: string): void {
  if (!PLAYER_NAME_PATTERN.test(name)) {
    throw new InvalidPlayerNameError(name)
  }
}

export interface OfflineAccount {
  kind: 'offline'
  name: string
  uuid: string
}

/**
 * Yggdrasil（authlib-injector 外置登录）账户。
 * uuid 为服务端 profile UUID（无连字符，规范序列化形式）；
 * accessToken/clientToken 由登录/刷新更新，仅存内存与账户文件，绝不明文出 IPC。
 */
export interface YggdrasilAccount {
  kind: 'yggdrasil'
  name: string
  uuid: string
  /** 认证服务器 API 根（带尾斜杠）。 */
  apiRoot: string
  accessToken: string
  clientToken: string
  /** 服务器显示名（来自元数据 meta.serverName，可缺省）。 */
  serverName?: string
}

export type Account = OfflineAccount | YggdrasilAccount

interface AccountFile {
  accounts: Account[]
}

const ACCOUNTS_FILE = 'accounts.json'

/** 单条账户记录校验 + 归一化；非法返回 null。旧格式（无 kind，M1/M2 时代）视为离线账户。 */
function normalizeAccount(value: unknown): Account | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const { name, uuid, kind } = v
  if (typeof name !== 'string' || typeof uuid !== 'string') return null
  if (kind === 'yggdrasil') {
    const { apiRoot, accessToken, clientToken, serverName } = v
    if (
      typeof apiRoot !== 'string' ||
      apiRoot === '' ||
      typeof accessToken !== 'string' ||
      typeof clientToken !== 'string' ||
      name === ''
    ) {
      return null
    }
    return {
      kind: 'yggdrasil',
      name,
      uuid,
      apiRoot,
      accessToken,
      clientToken,
      ...(typeof serverName === 'string' ? { serverName } : {})
    }
  }
  // 无 kind 的旧格式与显式 offline 都按离线账户校验
  return PLAYER_NAME_PATTERN.test(name) ? { kind: 'offline', name, uuid } : null
}

/** 读取账户列表（accounts.json），文件不存在或内容不合法时返回空数组。旧格式条目归一化为 offline。 */
export async function loadAccounts(dir: string): Promise<Account[]> {
  let raw: string
  try {
    raw = await fs.readFile(join(dir, ACCOUNTS_FILE), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return []
    const accounts = (parsed as { accounts?: unknown }).accounts
    if (!Array.isArray(accounts)) return []
    return accounts.map(normalizeAccount).filter((a): a is Account => a !== null)
  } catch {
    return []
  }
}

/**
 * 写入账户列表到 accounts.json。
 * 离线账户统一重算离线 UUID；Yggdrasil 账户的 uuid/token 等字段原样保留（服务端下发，不覆盖）。
 */
export async function saveAccounts(dir: string, accounts: Account[]): Promise<void> {
  const fixed = accounts.map((a) => {
    if (a.kind === 'yggdrasil') {
      if (a.name === '') throw new InvalidPlayerNameError(a.name)
      return a
    }
    validatePlayerName(a.name)
    return { kind: 'offline', name: a.name, uuid: offlineUuid(a.name) } satisfies OfflineAccount
  })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, ACCOUNTS_FILE),
    JSON.stringify({ accounts: fixed } satisfies AccountFile, null, 2) + '\n'
  )
}
