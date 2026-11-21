import type { ChatMessage } from './client'

/** 内存会话（MVP 不落盘）：system prompt + 对话历史。 */
export class ChatSession {
  private readonly history: ChatMessage[] = []

  constructor(private readonly system: string) {}

  addUser(content: string): void {
    this.history.push({ role: 'user', content })
  }

  addAssistant(content: string): void {
    this.history.push({ role: 'assistant', content })
  }

  /** 含 system 的完整消息列表（供 client.send）。 */
  messages(): ChatMessage[] {
    return [{ role: 'system', content: this.system }, ...this.history]
  }

  /** 会话历史条数（不含 system）。 */
  size(): number {
    return this.history.length
  }

  clear(): void {
    this.history.length = 0
  }
}
