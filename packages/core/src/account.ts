import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { InvalidPlayerNameError } from './errors'

/** 玩家名规则：3-16 位字母/数字/下划线。 */
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

/** 校验玩家名，非法时抛出 InvalidPlayerNameError。 */
export function validatePlayerName(name: string): void {
  if (!PLAYER_NAME_PATTERN.test(name)) {
    throw new InvalidPlayerNameError(name)
  }
}

export interface Account {
  name: string
  uuid: string
}

interface AccountFile {
  accounts: Account[]
}

const ACCOUNTS_FILE = 'accounts.json'

function isAccount(value: unknown): value is Account {
  const v = value as Partial<Account> | null
  return (
    v !== null &&
    typeof v.name === 'string' &&
    typeof v.uuid === 'string' &&
    PLAYER_NAME_PATTERN.test(v.name)
  )
}

/** 读取账户列表（accounts.json），文件不存在或内容不合法时返回空数组。 */
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
    return accounts.filter(isAccount)
  } catch {
    return []
  }
}

/** 写入账户列表到 accounts.json。每个账户都会重新生成并覆盖离线 UUID。 */
export async function saveAccounts(dir: string, accounts: Account[]): Promise<void> {
  for (const account of accounts) {
    validatePlayerName(account.name)
  }
  const fixed = accounts.map((a) => ({ name: a.name, uuid: offlineUuid(a.name) }))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, ACCOUNTS_FILE),
    JSON.stringify({ accounts: fixed } satisfies AccountFile, null, 2) + '\n'
  )
}
