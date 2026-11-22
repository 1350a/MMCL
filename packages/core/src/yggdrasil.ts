import { randomUUID } from 'node:crypto'
import { describeFetchError } from './download'
import { YggdrasilError } from './errors'

/**
 * Yggdrasil 协议客户端（authlib-injector 服务端技术规范）。
 * 端点均以认证服务器 API 根（apiRoot，带尾斜杠）为前缀。
 */

/** 请求固定携带的 agent 字段（规范定义的固定值）。 */
const AGENT = { name: 'Minecraft', version: 1 } as const

/** 协议请求默认超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 15_000

/** Profile 序列化（规范：id 为无连字符 UUID，properties 仅特定场景返回）。 */
export interface YgProfile {
  id: string
  name: string
  properties?: Array<{ name: string; value: string; signature?: string }>
}

/** User 序列化。 */
export interface YgUser {
  id: string
  properties?: Array<{ name: string; value: string }>
}

/** 认证服务器元数据（GET API 根）。 */
export interface AuthServerMeta {
  meta: {
    serverName?: string
    implementationName?: string
    implementationVersion?: string
    links?: { homepage?: string; register?: string }
  }
  skinDomains?: string[]
  signaturePublickey?: string
}

export interface AuthenticateResponse {
  accessToken: string
  clientToken: string
  availableProfiles: YgProfile[]
  selectedProfile?: YgProfile
  user?: YgUser
}

export interface RefreshResponse {
  accessToken: string
  clientToken: string
  selectedProfile?: YgProfile
  user?: YgUser
}

export interface SkinInfo {
  url: string
  /** 皮肤模型：default（4px 臂）或 slim（3px 臂）。 */
  model?: 'default' | 'slim'
}

export interface ProfileWithSkin {
  name: string
  skin: SkinInfo | null
}

/** 生成 clientToken：无连字符 UUID（规范允许任意字符串，这是惯例形式）。 */
export function generateClientToken(): string {
  return randomUUID().replace(/-/g, '')
}

/** 规范化 API 根：补尾斜杠，便于直接拼端点。 */
function normalizeApiRoot(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * ALI（API Location Indication）解析：把用户输入的（可能缩写的）地址解析为真实 API 根。
 * 无协议时补 HTTPS（禁止降级 HTTP）；GET 跟随重定向后读 X-Authlib-Injector-API-Location 头，
 * 头存在且指向自身以外的地址则采用之，否则当前地址即 API 根。
 */
export async function resolveApiRoot(input: string, signal?: AbortSignal): Promise<string> {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('认证服务器地址为空')
  const initial = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  // 注意：这里只把"外部取消 signal"传给 tryFetch；15s 请求超时由每次 fetchWithTimeout 自带，
  // 两者绝不能合并后再传入——否则超时会误判为主动取消，重试与错误包装全部失效。
  let res: Response
  try {
    res = await tryFetch(initial, signal, { redirect: 'follow' }, 1)
  } catch (err) {
    if (signal?.aborted) throw err
    const hint = initial.startsWith('https://')
      ? '。若该服务器仅支持 HTTP（如内网部署），请显式输入 http:// 开头的完整地址'
      : ''
    throw new Error(
      `无法连接认证服务器（${initial}）：${describeNetworkFailure(err)}${hint}`
    )
  }
  const ali = res.headers.get('x-authlib-injector-api-location')
  if (!ali) return normalizeApiRoot(res.url || initial)
  // 相对地址按最终 URL 解析为绝对地址；指向自身时规范要求忽略
  const target = normalizeApiRoot(new URL(ali, res.url || initial).toString())
  const current = normalizeApiRoot(res.url || initial)
  return target === current ? current : target
}

/** GET API 根取元数据；同时返回响应原文的 base64（供启动参数 prefetched 使用）。 */
export async function fetchServerMeta(
  apiRoot: string,
  signal?: AbortSignal
): Promise<{ meta: AuthServerMeta; prefetched: string }> {
  let res: Response
  try {
    res = await tryFetch(apiRoot, signal, undefined, 1)
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(`获取认证服务器元数据失败（${apiRoot}）：${describeNetworkFailure(err)}`)
  }
  if (!res.ok) throw new YggdrasilError(res.status, 'MetadataError', undefined, apiRoot)
  const raw = await res.text()
  const meta = JSON.parse(raw) as AuthServerMeta
  if (typeof meta !== 'object' || meta === null || typeof meta.meta !== 'object' || meta.meta === null) {
    throw new Error(`认证服务器元数据格式不正确: ${apiRoot}`)
  }
  return { meta, prefetched: Buffer.from(raw, 'utf8').toString('base64') }
}

interface PostJsonOptions {
  accessToken?: string
  signal?: AbortSignal
  /** 网络失败自动重试次数（默认 0）。仅幂等请求（如 validate）使用；authenticate/refresh 有副作用不重试。 */
  retries?: number
}

/** POST JSON 并解析响应；网络失败转可读错误，非 2xx 按规范的错误结构抛 YggdrasilError。 */
async function postJson<T>(url: string, body: unknown, options: PostJsonOptions = {}): Promise<T> {
  let res: Response
  try {
    res = await tryFetch(url, options.signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    }, options.retries ?? 0)
  } catch (err) {
    if (options.signal?.aborted) throw err
    throw new Error(`认证服务器请求失败（${url}）：${describeNetworkFailure(err)}`)
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: string; errorMessage?: string; cause?: string }
      | null
    throw new YggdrasilError(
      res.status,
      payload?.error ?? `HTTP ${res.status}`,
      payload?.errorMessage,
      url
    )
  }
  // validate/invalidate 成功返回 204 无内容
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** fetch + 统一超时。 */
async function fetchWithTimeout(
  url: string,
  signal?: AbortSignal,
  init?: RequestInit
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  return fetch(url, { ...init, signal: combined })
}

/** 把底层 fetch 失败翻译成可读原因（超时 / 连接拒绝 / DNS / 证书劫持）。 */
function describeNetworkFailure(err: unknown): string {
  const e = err as Error & { cause?: Error & { code?: string } }
  if (e?.name === 'TimeoutError') return '请求超时（网络不稳定或服务器无响应）'
  const code = e?.cause?.code ?? ''
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return '连接超时（网络不稳定或服务器无响应）'
  if (code === 'ECONNREFUSED') return '连接被拒绝（服务器未在该地址监听）'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名无法解析'
  return describeFetchError(err)
}

/**
 * 幂等请求：网络失败自动重试一次（应对校园网/国际链路的间歇丢包），仍失败抛出原始错误。
 * 主动取消（signal 中止）不重试、原样抛出。
 */
async function tryFetch(
  url: string,
  signal: AbortSignal | undefined,
  init: RequestInit | undefined,
  retries: number
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, signal, init)
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = err
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastErr
}

/** 登录：POST /authserver/authenticate（requestUser 固定 true，便于启动器同步用户属性）。 */
export function authenticate(
  apiRoot: string,
  params: { username: string; password: string; clientToken: string; signal?: AbortSignal }
): Promise<AuthenticateResponse> {
  return postJson(`${apiRoot}authserver/authenticate`, {
    agent: AGENT,
    username: params.username,
    password: params.password,
    clientToken: params.clientToken,
    requestUser: true
  }, { signal: params.signal })
}

/**
 * 刷新 token（旧 token 作废、发新 token，clientToken 不变）。
 * selectedProfile 存在时即角色选择操作（要求原 token 未绑定角色）。
 */
export function refresh(
  apiRoot: string,
  params: {
    accessToken: string
    clientToken: string
    selectedProfile?: YgProfile
    signal?: AbortSignal
  }
): Promise<RefreshResponse> {
  return postJson(`${apiRoot}authserver/refresh`, {
    accessToken: params.accessToken,
    clientToken: params.clientToken,
    requestUser: true,
    ...(params.selectedProfile ? { selectedProfile: params.selectedProfile } : {})
  }, { signal: params.signal })
}

/** 校验 token 有效性（幂等，网络失败自动重试一次）：204 → true；403（Invalid token）→ false；其他错误抛出。 */
export async function validate(
  apiRoot: string,
  params: { accessToken: string; clientToken: string; signal?: AbortSignal }
): Promise<boolean> {
  try {
    await postJson(`${apiRoot}authserver/validate`, {
      accessToken: params.accessToken,
      clientToken: params.clientToken
    }, { signal: params.signal, retries: 1 })
    return true
  } catch (err) {
    if (err instanceof YggdrasilError && err.status === 403) return false
    throw err
  }
}

/** 吊销 token（服务器恒返回 204，无论该 token 是否存在）。 */
export function invalidate(
  apiRoot: string,
  params: { accessToken: string; clientToken: string; signal?: AbortSignal }
): Promise<void> {
  return postJson(`${apiRoot}authserver/invalidate`, {
    accessToken: params.accessToken,
    clientToken: params.clientToken
  }, { signal: params.signal })
}

/** 查询 profile 完整属性并解码皮肤信息；profile 不存在（204）时返回 null。 */
export async function fetchProfileWithSkin(
  apiRoot: string,
  profileUuid: string,
  signal?: AbortSignal
): Promise<ProfileWithSkin | null> {
  const unhyphenated = profileUuid.replace(/-/g, '')
  const url = `${apiRoot}sessionserver/session/minecraft/profile/${unhyphenated}`
  let res: Response
  try {
    res = await tryFetch(url, signal, undefined, 1)
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(`获取角色皮肤信息失败（${url}）：${describeNetworkFailure(err)}`)
  }
  if (res.status === 204) return null
  if (!res.ok) {
    throw new YggdrasilError(res.status, `HTTP ${res.status}`, undefined, url)
  }
  const profile = (await res.json()) as YgProfile
  const texturesProp = profile.properties?.find((p) => p.name === 'textures')
  if (!texturesProp) return { name: profile.name, skin: null }
  let skin: SkinInfo | null = null
  try {
    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8')) as {
      textures?: Record<string, { url?: string; metadata?: Record<string, string> }>
    }
    const entry = decoded.textures?.SKIN
    if (entry?.url) {
      const model = entry.metadata?.['model']
      skin = { url: entry.url, model: model === 'slim' ? 'slim' : 'default' }
    }
  } catch {
    // textures 属性解码失败：按无皮肤处理
  }
  return { name: profile.name, skin }
}
