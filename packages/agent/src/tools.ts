/**
 * AI 工具定义（DESIGN.md §5.2 的 AiTool 形态，name/description/JSON Schema parameters
 * 刻意与 MCP 工具描述兼容，为后续对齐预留）。
 * handler 依赖由调用方注入，本包不 import @mcl/core，保持纯协议层。
 */
export interface AiTool {
  name: string
  description: string
  /** JSON Schema。 */
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<string>
}
