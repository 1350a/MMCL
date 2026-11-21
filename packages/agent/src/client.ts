import type { AiTool } from './tools'

/** OpenAI 兼容消息。role: system | user | assistant | tool。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** assistant 带 tool_calls 时存在；tool 角色必须带 tool_call_id。 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

export interface ChatClientOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 单次 send 的工具调用轮数上限，防失控循环。 */
  maxToolRounds?: number
}

export interface ChatCallbacks {
  /** 流式文本增量。 */
  onDelta?: (text: string) => void
  /** 中断信号。 */
  signal?: AbortSignal
}

export interface ChatResult {
  content: string
  /** 本轮实际执行的工具调用记录（name + args 摘要）。 */
  toolCalls: Array<{ name: string; args: string }>
}

const TOOL_ROUNDS_DEFAULT = 8

/** OpenAI 兼容 chat completions 客户端：fetch + SSE 自实现，无 SDK。 */
export class ChatClient {
  constructor(private readonly options: ChatClientOptions) {}

  private url(): string {
    // baseURL 原样作为前缀（用户填 /v1、/v4 等各自兼容层的习惯不一），不强插版本段
    const base = this.options.baseUrl.replace(/\/+$/, '')
    return `${base}/chat/completions`
  }

  /**
   * 发送对话直到得到最终回复。流式增量经 callbacks.onDelta 推给调用方；
   * 模型请求工具时本地执行 AiTool.handler 并回传结果，最多 maxToolRounds 轮。
   */
  async send(
    messages: ChatMessage[],
    tools: AiTool[] = [],
    callbacks: ChatCallbacks = {}
  ): Promise<ChatResult> {
    const working = [...messages]
    const executed: Array<{ name: string; args: string }> = []
    let content = ''

    for (let round = 0; round <= (this.options.maxToolRounds ?? TOOL_ROUNDS_DEFAULT); round++) {
      const body: Record<string, unknown> = {
        model: this.options.model,
        messages: working,
        stream: true
      }
      if (tools.length > 0) body.tools = tools.map(toOpenAiTool)

      const res = await fetch(this.url(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify(body),
        signal: callbacks.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`chat completions failed: HTTP ${res.status} ${text.slice(0, 300)}`)
      }
      if (!res.body) throw new Error('empty response body')

      const stream = res.body as unknown as AsyncIterable<Uint8Array>
      let roundContent = ''
      const pendingCalls = new Map<number, { id: string; name: string; args: string }>()
      let finish = 'stop'

      // SSE 解析：事件以空行分隔，data: 前缀行承载 JSON chunk
      let buffer = ''
      for await (const chunk of stream) {
        buffer += new TextDecoder().decode(chunk)
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '' || data === '[DONE]') continue
            let parsed: {
              choices?: Array<{
                delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
                finish_reason?: string | null
              }>
            }
            try {
              parsed = JSON.parse(data)
            } catch {
              continue // 非 JSON 行（如注释）忽略
            }
            const choice = parsed.choices?.[0]
            if (!choice) continue
            if (choice.finish_reason) finish = choice.finish_reason
            const delta = choice.delta
            if (delta?.content) {
              roundContent += delta.content
              callbacks.onDelta?.(delta.content)
            }
            for (const call of delta?.tool_calls ?? []) {
              const acc = pendingCalls.get(call.index) ?? { id: '', name: '', args: '' }
              if (call.id) acc.id = call.id
              if (call.function?.name) acc.name += call.function.name
              if (call.function?.arguments) acc.args += call.function.arguments
              pendingCalls.set(call.index, acc)
            }
          }
        }
      }

      content += roundContent

      if (finish !== 'tool_calls' || pendingCalls.size === 0) {
        return { content, toolCalls: executed }
      }

      // 本地执行工具并回传结果，进入下一轮
      working.push({
        role: 'assistant',
        content: roundContent || null,
        tool_calls: [...pendingCalls.values()].map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.args }
        }))
      })
      for (const call of pendingCalls.values()) {
        executed.push({ name: call.name, args: call.args })
        const tool = tools.find((t) => t.name === call.name)
        let result: string
        if (!tool) {
          result = `unknown tool: ${call.name}`
        } else {
          try {
            const args = call.args.trim() === '' ? {} : (JSON.parse(call.args) as Record<string, unknown>)
            result = await tool.handler(args)
          } catch (err) {
            result = `tool error: ${(err as Error).message}`
          }
        }
        working.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result })
      }
    }

    return { content, toolCalls: executed }
  }
}

function toOpenAiTool(tool: AiTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}
