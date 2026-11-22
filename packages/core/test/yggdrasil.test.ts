import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  authenticate,
  fetchProfileWithSkin,
  fetchServerMeta,
  generateClientToken,
  invalidate,
  refresh,
  resolveApiRoot,
  validate,
  YggdrasilError
} from '../src'

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

interface RecordedRequest {
  method: string
  url: string
  body: unknown
  headers: Record<string, string | undefined>
}

/**
 * Yggdrasil fixture：按注册的路由回放响应，记录请求。
 * route 键形如 'POST /authserver/authenticate'，值为 { status?, json?, text?, headers? }。
 */
async function startFixture(
  routes: Record<string, { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>,
  options: { aliHeader?: string } = {}
): Promise<{ apiRoot: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : null,
        headers: {
          ali: req.headers['x-authlib-injector-api-location'] as string | undefined,
          contentType: req.headers['content-type']
        }
      })
      if (options.aliHeader) {
        res.setHeader('X-Authlib-Injector-API-Location', options.aliHeader)
      }
      const route = routes[`${req.method} ${req.url}`]
      if (!route) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json; charset=utf-8', ...route.headers })
      if (route.json !== undefined) res.end(JSON.stringify(route.json))
      else if (route.text !== undefined) res.end(route.text)
      else res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { apiRoot: `http://127.0.0.1:${port}/`, requests }
}

const profileA = { id: 'a'.repeat(32), name: 'Steve' }
const profileB = { id: 'b'.repeat(32), name: 'Alex' }

describe('generateClientToken', () => {
  it('生成无连字符 UUID，且两次生成不同', () => {
    const token = generateClientToken()
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(token).not.toContain('-')
    expect(token).not.toBe(generateClientToken())
  })
})

describe('resolveApiRoot（ALI 解析）', () => {
  it('响应无 ALI 头时当前地址即 API 根；无协议输入自动补 HTTPS', async () => {
    const { apiRoot } = await startFixture({})
    // fixture 是 http://，手动带上协议走它；https 无法对 127.0.0.1 本地服务器生效
    const resolved = await resolveApiRoot(apiRoot)
    expect(resolved).toBe(apiRoot)
  })

  it('ALI 头（绝对地址）指向真实 API 根', async () => {
    const inner = await startFixture({})
    // 外层服务器返回 ALI 头指向内层 apiRoot
    const outer = await startFixture({}, { aliHeader: inner.apiRoot })
    const resolved = await resolveApiRoot(outer.apiRoot)
    expect(resolved).toBe(inner.apiRoot)
  })

  it('ALI 头为相对地址时按当前 URL 解析', async () => {
    const outer = await startFixture({}, { aliHeader: '/api/yggdrasil/' })
    const resolved = await resolveApiRoot(outer.apiRoot)
    expect(resolved).toBe(new URL('/api/yggdrasil/', outer.apiRoot).toString())
  })

  it('ALI 指向自身时忽略（当前地址即 API 根）', async () => {
    const server = await startFixture({}, { aliHeader: '/' })
    const resolved = await resolveApiRoot(server.apiRoot)
    // '/' 解析后与当前 URL 相同 → 按规范忽略，采用当前地址
    expect(resolved).toBe(server.apiRoot)
  })

  it('输入缺尾斜杠时规范化补齐', async () => {
    const server = await startFixture({})
    const resolved = await resolveApiRoot(server.apiRoot.replace(/\/$/, ''))
    expect(resolved).toBe(server.apiRoot)
  })

  it('不可达地址抛可读错误（不降级，https 失败时引导显式 http）', async () => {
    // 关闭的端口：连接拒绝
    await expect(resolveApiRoot('http://127.0.0.1:1/')).rejects.toThrow(/无法连接认证服务器/)
    // 自动补 HTTPS 的地址失败时，提示改用显式 http://
    const err = await resolveApiRoot('127.0.0.1:1').catch((e) => e)
    expect(err.message).toContain('http://')
  })

  it('间歇丢包：幂等 GET 第一次超时重试后成功', async () => {
    const realFetch = globalThis.fetch
    let calls = 0
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls++
      if (calls === 1) {
        const timeoutErr = new Error('The operation was aborted due to timeout')
        timeoutErr.name = 'TimeoutError'
        throw timeoutErr
      }
      return realFetch(url, init)
    })
    try {
      const server = await startFixture({})
      const resolved = await resolveApiRoot(server.apiRoot)
      expect(resolved).toBe(server.apiRoot)
      expect(calls).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('网络失败转可读错误（含 URL 与原因）', async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout')
      timeoutErr.name = 'TimeoutError'
      throw timeoutErr
    })
    try {
      const err = await resolveApiRoot('http://127.0.0.1:1/').catch((e) => e)
      expect(err.message).toContain('无法连接认证服务器')
      expect(err.message).toContain('请求超时')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fetchServerMeta 网络失败抛可读错误', async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch failed')
    })
    try {
      await expect(fetchServerMeta('https://unreachable.invalid/')).rejects.toThrow(/获取认证服务器元数据失败/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('fetchServerMeta', () => {
  it('返回元数据，prefetched 为响应原文 base64', async () => {
    const metaJson = {
      meta: { serverName: '测试认证服务器' },
      skinDomains: ['example.com', '.example.com'],
      signaturePublickey: '-----BEGIN PUBLIC KEY-----\nX\n-----END PUBLIC KEY-----\n'
    }
    const { apiRoot } = await startFixture({ 'GET /': { json: metaJson } })
    const { meta, prefetched } = await fetchServerMeta(apiRoot)
    expect(meta.meta.serverName).toBe('测试认证服务器')
    expect(meta.skinDomains).toEqual(['example.com', '.example.com'])
    expect(prefetched).toBe(Buffer.from(JSON.stringify(metaJson), 'utf8').toString('base64'))
  })

  it('meta 结构不完整时抛错', async () => {
    const { apiRoot } = await startFixture({ 'GET /': { json: { unexpected: true } } })
    await expect(fetchServerMeta(apiRoot)).rejects.toThrow(/格式不正确/)
  })
})

describe('authenticate', () => {
  it('请求体含 agent/clientToken/requestUser:true，响应解析 selectedProfile', async () => {
    const response = {
      accessToken: 'token-1',
      clientToken: 'ct-1',
      availableProfiles: [profileA],
      selectedProfile: profileA,
      user: { id: 'u'.repeat(32) }
    }
    const { apiRoot, requests } = await startFixture({ 'POST /authserver/authenticate': { json: response } })
    const result = await authenticate(apiRoot, { username: 'user@example.com', password: 'pass', clientToken: 'ct-1' })

    expect(result.accessToken).toBe('token-1')
    expect(result.selectedProfile?.id).toBe(profileA.id)
    const req = requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/authserver/authenticate')
    expect(req.body).toEqual({
      agent: { name: 'Minecraft', version: 1 },
      username: 'user@example.com',
      password: 'pass',
      clientToken: 'ct-1',
      requestUser: true
    })
    expect(req.headers.contentType).toContain('application/json')
  })

  it('凭据错误（403 ForbiddenOperationException）抛 YggdrasilError 且带服务端 errorMessage', async () => {
    const { apiRoot } = await startFixture({
      'POST /authserver/authenticate': {
        status: 403,
        json: { error: 'ForbiddenOperationException', errorMessage: 'Invalid credentials. Invalid username or password.' }
      }
    })
    const err = await authenticate(apiRoot, { username: 'u', password: 'bad', clientToken: 'ct' }).catch((e) => e)
    expect(err).toBeInstanceOf(YggdrasilError)
    expect(err.status).toBe(403)
    expect(err.error).toBe('ForbiddenOperationException')
    expect(err.errorMessage).toContain('Invalid credentials')
  })
})

describe('refresh', () => {
  it('携带 accessToken/clientToken/requestUser，可选 selectedProfile 触发角色选择', async () => {
    const response = { accessToken: 'token-2', clientToken: 'ct-1', selectedProfile: profileA }
    const { apiRoot, requests } = await startFixture({ 'POST /authserver/refresh': { json: response } })
    const result = await refresh(apiRoot, {
      accessToken: 'token-1',
      clientToken: 'ct-1',
      selectedProfile: profileA
    })

    expect(result.accessToken).toBe('token-2')
    expect(requests[0].body).toEqual({
      accessToken: 'token-1',
      clientToken: 'ct-1',
      requestUser: true,
      selectedProfile: profileA
    })
  })

  it('不带 selectedProfile 时请求体无该字段', async () => {
    const { apiRoot, requests } = await startFixture({
      'POST /authserver/refresh': { json: { accessToken: 't2', clientToken: 'ct' } }
    })
    await refresh(apiRoot, { accessToken: 't1', clientToken: 'ct' })
    expect(requests[0].body).toEqual({ accessToken: 't1', clientToken: 'ct', requestUser: true })
  })
})

describe('validate / invalidate', () => {
  it('validate 204 → true；403 Invalid token → false', async () => {
    const good = await startFixture({ 'POST /authserver/validate': { status: 204 } })
    expect(await validate(good.apiRoot, { accessToken: 't', clientToken: 'c' })).toBe(true)

    const bad = await startFixture({
      'POST /authserver/validate': { status: 403, json: { error: 'ForbiddenOperationException', errorMessage: 'Invalid token.' } }
    })
    expect(await validate(bad.apiRoot, { accessToken: 't', clientToken: 'c' })).toBe(false)
  })

  it('validate 幂等重试：第一次网络超时，重试后 204 → true', async () => {
    const realFetch = globalThis.fetch
    let calls = 0
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls++
      if (calls === 1) {
        const timeoutErr = new Error('The operation was aborted due to timeout')
        timeoutErr.name = 'TimeoutError'
        throw timeoutErr
      }
      return realFetch(url, init)
    })
    try {
      const { apiRoot } = await startFixture({ 'POST /authserver/validate': { status: 204 } })
      expect(await validate(apiRoot, { accessToken: 't', clientToken: 'c' })).toBe(true)
      expect(calls).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('validate 其他错误（如 500）抛出而非返回 false', async () => {
    const { apiRoot } = await startFixture({
      'POST /authserver/validate': { status: 500, json: { error: 'ServerError' } }
    })
    await expect(validate(apiRoot, { accessToken: 't', clientToken: 'c' })).rejects.toBeInstanceOf(YggdrasilError)
  })

  it('invalidate 204 成功；请求体含 accessToken 与 clientToken', async () => {
    const { apiRoot, requests } = await startFixture({ 'POST /authserver/invalidate': { status: 204 } })
    await expect(invalidate(apiRoot, { accessToken: 't', clientToken: 'c' })).resolves.toBeUndefined()
    expect(requests[0].body).toEqual({ accessToken: 't', clientToken: 'c' })
  })
})

describe('fetchProfileWithSkin', () => {
  const texturesValue = Buffer.from(
    JSON.stringify({
      timestamp: 1700000000000,
      profileId: profileA.id,
      profileName: 'Steve',
      textures: {
        SKIN: { url: 'https://skin.example.com/textures/abc123', metadata: { model: 'slim' } },
        CAPE: { url: 'https://skin.example.com/textures/cape1' }
      }
    }),
    'utf8'
  ).toString('base64')

  it('解码 textures 属性 → SkinInfo（url + slim 模型）', async () => {
    const { apiRoot, requests } = await startFixture({
      [`GET /sessionserver/session/minecraft/profile/${profileA.id}`]: {
        json: { ...profileA, properties: [{ name: 'textures', value: texturesValue }] }
      }
    })
    const result = await fetchProfileWithSkin(apiRoot, profileA.id)
    expect(result?.name).toBe('Steve')
    expect(result?.skin).toEqual({ url: 'https://skin.example.com/textures/abc123', model: 'slim' })
    // 请求使用无连字符 UUID
    expect(requests[0].url).toBe(`/sessionserver/session/minecraft/profile/${profileA.id}`)
  })

  it('无 textures 属性 → skin 为 null；profile 不存在（204）→ null', async () => {
    const noProp = await startFixture({ [`GET /sessionserver/session/minecraft/profile/${profileA.id}`]: { json: profileA } })
    expect(await fetchProfileWithSkin(noProp.apiRoot, profileA.id)).toEqual({ name: 'Steve', skin: null })

    const missing = await startFixture({ [`GET /sessionserver/session/minecraft/profile/${profileA.id}`]: { status: 204 } })
    expect(await fetchProfileWithSkin(missing.apiRoot, profileA.id)).toBeNull()
  })

  it('带连字符的输入 UUID 会被转为无连字符再请求', async () => {
    const hyphenated = `${profileA.id.slice(0, 8)}-${profileA.id.slice(8, 12)}-${profileA.id.slice(12, 16)}-${profileA.id.slice(16, 20)}-${profileA.id.slice(20)}`
    const { apiRoot, requests } = await startFixture({
      [`GET /sessionserver/session/minecraft/profile/${profileA.id}`]: { json: profileA }
    })
    await fetchProfileWithSkin(apiRoot, hyphenated)
    expect(requests[0].url).toBe(`/sessionserver/session/minecraft/profile/${profileA.id}`)
  })
})
