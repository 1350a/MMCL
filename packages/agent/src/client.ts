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
  /**
   * 发送给 API 的历史条数上限（不含 system）：system + 最近 N 条。
   * undefined / 0 = 不截断。会话本地仍保留全量。
   */
  maxHistoryMessages?: number
  /**
   * 空闲超时（毫秒）：建立连接后若这么久没有任何 SSE 增量则中止报错，默认 60s。
   * 防"连接挂着但模型不吐字"的假死。
   */
  idleTimeoutMs?: number
}

/**
 * 工具活动事件（干活过程可视化）：模型流式生成工具参数 → 参数收齐本地执行 → 执行完成。
 * delta 里的 arguments 是逐块到达的，args 事件让 UI 能实时展示"模型正在写什么"。
 */
export type AiToolEvent =
  | { kind: 'args'; call: number; name: string; delta: string }
  | { kind: 'exec'; call: number; name: string; args: string }
  | { kind: 'done'; call: number; name: string; result: string }

export interface ChatCallbacks {
  /** 流式文本增量。 */
  onDelta?: (text: string) => void
  /** 工具活动事件（UI 过程可视化）。 */
  onToolEvent?: (event: AiToolEvent) => void
  /** 中断信号。 */
  signal?: AbortSignal
}

export interface ChatResult {
  content: string
  /** 本轮实际执行的工具调用记录（name + args 摘要）。 */
  toolCalls: Array<{ name: string; args: string }>
}

const TOOL_ROUNDS_DEFAULT = 8
/** 历史截断默认保留最近条数。 */
const MAX_HISTORY_DEFAULT = 20
/** 空闲超时默认值：60s 无增量即视为假死。 */
const IDLE_TIMEOUT_DEFAULT = 60_000

/** idleTimer 触发 abort 时携带的标记，用于与其他中止来源区分。 */
const IDLE_ABORT_REASON = new Error('ai-idle-timeout')

/** 把输入消息列表截为 system（若有）+ 最近 N 条（截断只影响发送视图，不动调用方的数组）。 */
function truncateHistory(messages: ChatMessage[], max: number): ChatMessage[] {
  if (max <= 0 || messages.length <= max) return messages
  const hasLeadingSystem = messages[0]?.role === 'system'
  const system = hasLeadingSystem ? [messages[0]] : []
  const rest = hasLeadingSystem ? messages.slice(1) : messages
  return [...system, ...rest.slice(-max)]
}

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
        messages: truncateHistory(working, this.options.maxHistoryMessages ?? MAX_HISTORY_DEFAULT),
        stream: true
      }
      if (tools.length > 0) body.tools = tools.map(toOpenAiTool)

      // 空闲超时：连接后 60s 无任何 SSE 增量即中止（防模型假死挂死会话）
      const idleController = new AbortController()
      const idleSignal = idleController.signal
      const combinedSignal = callbacks.signal
        ? AbortSignal.any([callbacks.signal, idleSignal])
        : idleSignal
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(
          () => idleController.abort(IDLE_ABORT_REASON),
          this.options.idleTimeoutMs ?? IDLE_TIMEOUT_DEFAULT
        )
      }

      let res: Response
      let roundContent = ''
      const pendingCalls = new Map<number, { id: string; name: string; args: string }>()
      let finish = 'stop'
      try {
        armIdle()
        res = await fetch(this.url(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`
          },
          body: JSON.stringify(body),
          signal: combinedSignal
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          const hint = res.status === 401 || res.status === 403 ? '（apiKey 无效或已过期，请检查 AI 配置）' : ''
          throw new Error(`chat completions failed: HTTP ${res.status}${hint} ${text.slice(0, 300)}`)
        }
        if (!res.body) throw new Error('empty response body')

        const stream = res.body as unknown as AsyncIterable<Uint8Array>

        // SSE 解析：事件以空行分隔，data: 前缀行承载 JSON chunk
        let buffer = ''
        for await (const chunk of stream) {
          armIdle() // 收到任何增量即喂狗
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
                if (call.function?.arguments) {
                  acc.args += call.function.arguments
                  callbacks.onToolEvent?.({ kind: 'args', call: call.index, name: acc.name, delta: call.function.arguments })
                }
                pendingCalls.set(call.index, acc)
              }
            }
          }
        }
        if (idleTimer) clearTimeout(idleTimer) // 本轮网络结束，工具本地执行期间不计时
      } catch (err) {
        // 空闲超时的 abort 转成可读错误；其他错误（含外部 signal 中止）原样抛
        if (idleSignal.aborted && idleSignal.reason === IDLE_ABORT_REASON) {
          const seconds = Math.round((this.options.idleTimeoutMs ?? IDLE_TIMEOUT_DEFAULT) / 1000)
          throw new Error(`AI 响应超时：${seconds} 秒无增量，已中止本次请求`)
        }
        throw err
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
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
      for (const [index, call] of [...pendingCalls.entries()]) {
        executed.push({ name: call.name, args: call.args })
        callbacks.onToolEvent?.({ kind: 'exec', call: index, name: call.name, args: call.args })
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
        callbacks.onToolEvent?.({ kind: 'done', call: index, name: call.name, result })
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
