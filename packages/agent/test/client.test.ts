import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ChatClient, ChatSession } from '../src'
import type { AiTool, ChatMessage } from '../src'

const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

const sse = (chunks: object[]): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

/** OpenAI 兼容 fixture：按请求顺序回放 SSE 响应，记录请求体。 */
async function startFixture(responses: string[]): Promise<{ baseUrl: string; bodies: unknown[] }> {
  const bodies: unknown[] = []
  let i = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (raw) bodies.push(JSON.parse(raw))
      const payload = responses[Math.min(i, responses.length - 1)]
      i++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, bodies }
}

const deltaContent = (text: string): object => ({ choices: [{ delta: { content: text } }] })

describe('ChatClient.send', () => {
  it('纯文本流：onDelta 增量与最终 content', async () => {
    const { baseUrl } = await startFixture([
      sse([deltaContent('你'), deltaContent('好'), deltaContent('，世界')])
    ])
    const client = new ChatClient({ baseUrl, apiKey: 'sk-test', model: 'test-model' })
    const deltas: string[] = []
    const result = await client.send([{ role: 'user', content: 'hi' }], [], { onDelta: (t) => deltas.push(t) })

    expect(result.content).toBe('你好，世界')
    expect(deltas).toEqual(['你', '好', '，世界'])
    expect(result.toolCalls).toEqual([])
  })

  it('tool call 往返：增量拼接 arguments → 本地执行 → 结果回传 → 最终回复', async () => {
    const first = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_versions', arguments: '{"li' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mit":2}' } }] }, finish_reason: 'tool_calls' }] }
    ])
    const second = sse([deltaContent('已装 2 个版本'), deltaContent('，最新 1.20.1')])
    const { baseUrl, bodies } = await startFixture([first, second])

    const handlerCalls: Array<Record<string, unknown>> = []
    const tools: AiTool[] = [
      {
        name: 'list_versions',
        description: '列出版本',
        parameters: { type: 'object', properties: { limit: { type: 'number' } } },
        handler: async (args) => {
          handlerCalls.push(args)
          return JSON.stringify({ installed: ['1.16.5', '1.20.1'] })
        }
      }
    ]

    const client = new ChatClient({ baseUrl, apiKey: 'sk-test', model: 'test-model' })
    const result = await client.send([{ role: 'user', content: '有哪些版本?' }], tools)

    expect(result.content).toBe('已装 2 个版本，最新 1.20.1')
    expect(result.toolCalls).toEqual([{ name: 'list_versions', args: '{"limit":2}' }])
    expect(handlerCalls).toEqual([{ limit: 2 }])

    // 第二次请求应包含 assistant 的 tool_calls 与 tool 结果消息
    const secondReq = bodies[1] as { messages: ChatMessage[] }
    const assistant = secondReq.messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.[0].function).toEqual({ name: 'list_versions', arguments: '{"limit":2}' })
    const toolMsg = secondReq.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('call_1')
    expect(toolMsg?.content).toContain('1.20.1')
  })

  it('未知工具 / handler 抛错都以字符串结果回传，不中断', async () => {
    const boom = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'boom_tool', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])
    const { baseUrl } = await startFixture([boom, sse([deltaContent('ok')])])
    const tools: AiTool[] = [
      { name: 'other', description: '', parameters: { type: 'object' }, handler: async () => 'x' }
    ]
    const client = new ChatClient({ baseUrl, apiKey: 'k', model: 'm' })
    const result = await client.send([{ role: 'user', content: 'x' }], tools)
    expect(result.content).toBe('ok')
  })

  it('HTTP 500 抛错', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500)
      res.end('boom')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo
    const client = new ChatClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm' })
    await expect(client.send([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 500/)
  })

  it('baseUrl 带不带 /v1 都能正确拼出 endpoint', async () => {
    for (const base of ['http://x', 'http://x/v1', 'http://x/v1/']) {
      const client = new ChatClient({ baseUrl: base, apiKey: 'k', model: 'm' })
      // @ts-expect-error 访问私有方法仅用于测试
      expect(client.url()).toBe('http://x/v1/chat/completions')
    }
  })
})

describe('ChatSession', () => {
  it('system 前置 + 历史追加 + clear', () => {
    const session = new ChatSession('你是启动器助手')
    session.addUser('hi')
    session.addAssistant('hello')
    expect(session.messages()).toEqual([
      { role: 'system', content: '你是启动器助手' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ])
    expect(session.size()).toBe(2)
    session.clear()
    expect(session.size()).toBe(0)
  })
})
