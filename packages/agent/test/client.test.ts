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

  it('onToolEvent：参数流式增量 → 执行 → 完成（干活过程可视化）', async () => {
    const first = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'gen_tool', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'rts":1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ])
    const second = sse([deltaContent('完成')])
    const { baseUrl } = await startFixture([first, second])
    const tools: AiTool[] = [
      { name: 'gen_tool', description: '', parameters: { type: 'object' }, handler: async () => '{"ok":true}' }
    ]

    const client = new ChatClient({ baseUrl, apiKey: 'k', model: 'm' })
    const events: Array<{ kind: string; call: number; name: string; text: string }> = []
    const result = await client.send([{ role: 'user', content: '写一个工具' }], tools, {
      onToolEvent: (e) => events.push({ kind: e.kind, call: e.call, name: e.name, text: e.kind === 'args' ? e.delta : e.kind === 'exec' ? e.args : e.result })
    })

    expect(result.content).toBe('完成')
    expect(events).toEqual([
      { kind: 'args', call: 0, name: 'gen_tool', text: '{"pa' },
      { kind: 'args', call: 0, name: 'gen_tool', text: 'rts":1}' },
      { kind: 'exec', call: 0, name: 'gen_tool', text: '{"parts":1}' },
      { kind: 'done', call: 0, name: 'gen_tool', text: '{"ok":true}' }
    ])
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

  it('baseUrl 原样作为前缀拼 endpoint（不强插 /v1）', async () => {
    const cases: Array<[string, string]> = [
      ['http://x', 'http://x/chat/completions'],
      ['http://x/v1', 'http://x/v1/chat/completions'],
      ['http://x/v4/', 'http://x/v4/chat/completions']
    ]
    for (const [base, expected] of cases) {
      const client = new ChatClient({ baseUrl: base, apiKey: 'k', model: 'm' })
      // @ts-expect-error 访问私有方法仅用于测试
      expect(client.url()).toBe(expected)
    }
  })

  it('历史截断：发送 system + 最近 N 条，会话本地保留全量', async () => {
    const { baseUrl, bodies } = await startFixture([sse([deltaContent('ok')])])
    const client = new ChatClient({ baseUrl, apiKey: 'k', model: 'm', maxHistoryMessages: 2 })
    const session = new ChatSession('你是启动器助手')
    for (let i = 0; i < 5; i++) {
      session.addUser(`问题${i}`)
      session.addAssistant(`回答${i}`)
    }
    await client.send(session.messages())

    const messages = (bodies[0] as { messages: ChatMessage[] }).messages
    expect(messages).toHaveLength(3) // system + 最近 2 条
    expect(messages[0]).toEqual({ role: 'system', content: '你是启动器助手' })
    expect(messages[1]).toEqual({ role: 'user', content: '问题4' })
    expect(messages[2]).toEqual({ role: 'assistant', content: '回答4' })
    expect(session.size()).toBe(10) // 本地会话不丢历史
  })

  it('maxHistoryMessages 为 0 时不截断', async () => {
    const { baseUrl, bodies } = await startFixture([sse([deltaContent('ok')])])
    const client = new ChatClient({ baseUrl, apiKey: 'k', model: 'm', maxHistoryMessages: 0 })
    const session = new ChatSession('s')
    session.addUser('a')
    session.addAssistant('b')
    session.addUser('c')
    await client.send(session.messages())
    expect((bodies[0] as { messages: ChatMessage[] }).messages).toHaveLength(4)
  })

  it('空闲超时：连接后持续无增量，idleTimeoutMs 到点中止并报可读错误', async () => {
    // 收到请求只回 SSE 响应头，不发送任何数据、不结束 → 流挂起直到空闲超时
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // 故意不 res.end()，保持挂起
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const { port } = server.address() as AddressInfo

    const client = new ChatClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', idleTimeoutMs: 150 })
    const err = await client.send([{ role: 'user', content: 'hi' }]).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('无增量')
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
