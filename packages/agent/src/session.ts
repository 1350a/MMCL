import type { ChatMessage } from './client'

/** 内存会话：system prompt + 对话历史（历史可导出/恢复，落盘由调用方负责）。 */
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

  /** 导出对话历史（不含 system；落盘/迁移用）。返回副本。 */
  exportHistory(): ChatMessage[] {
    return this.history.map((m) => ({ ...m }))
  }

  /** 恢复对话历史：只收 user/assistant，其他角色与非法条目丢弃（落盘恢复用）。 */
  restoreHistory(messages: ChatMessage[]): void {
    this.history.length = 0
    for (const m of messages) {
      if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
        this.history.push({ role: m.role, content: m.content })
      }
    }
  }

  clear(): void {
    this.history.length = 0
  }
}
