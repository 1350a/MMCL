import { useEffect, useRef, useState } from 'react'
import type { Run } from './useRunner'

/** AI 工具活动行（干活过程可视化）。 */
export interface AiActivityEntry {
  call: number
  name: string
  phase: 'args' | 'exec' | 'done'
  /** args 阶段累积的原始参数 / exec 的完整参数 / done 的结果。 */
  acc: string
}

/** AI 助手域：配置、对话流、工具活动与流式输出。 */
export function useAi(run: Run, setMessage: (m: string) => void, refreshMods: () => void) {
  const [aiConfig, setAiConfig] = useState<AiConfigPayload | null>(null)
  const [aiBase, setAiBase] = useState('')
  const [aiKey, setAiKey] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiMessages, setAiMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  const [aiStreaming, setAiStreaming] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiInput, setAiInput] = useState('')
  // AI 干活过程（工具参数流式生成 → 执行 → 完成；按 call 槽位演进，新一轮追加不覆盖）
  const [aiActivity, setAiActivity] = useState<AiActivityEntry[]>([])
  const aiChatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.mcl.getAiConfig().then((c) => {
      setAiConfig(c)
      setAiBase(c.baseUrl)
      setAiModel(c.model)
    })
    // AI 会话落盘回灌（重启恢复聊天显示）
    window.mcl.aiHistory().then((hist) => {
      if (hist.length > 0) setAiMessages(hist)
    })
    const unsubs = [
      window.mcl.onAiDelta(({ text }) => {
        setAiStreaming((s) => s + text)
      }),
      window.mcl.onAiTool((e) => {
        setAiActivity((prev) => {
          const next = [...prev]
          // 同一 call 槽位按 args → exec → done 演进；槽位复用（新一轮）时追加新行
          const findLast = (call: number, phase: AiActivityEntry['phase']): number => {
            for (let i = next.length - 1; i >= 0; i--) if (next[i].call === call && next[i].phase === phase) return i
            return -1
          }
          if (e.kind === 'args') {
            const i = findLast(e.call, 'args')
            const acc = (i >= 0 ? next[i].acc : '') + e.delta
            const name = e.name || (i >= 0 ? next[i].name : '')
            if (i >= 0) next[i] = { call: e.call, name, phase: 'args', acc }
            else next.push({ call: e.call, name, phase: 'args', acc })
          } else if (e.kind === 'exec') {
            const i = findLast(e.call, 'args')
            if (i >= 0) next[i] = { call: e.call, name: e.name, phase: 'exec', acc: e.args }
            else next.push({ call: e.call, name: e.name, phase: 'exec', acc: e.args })
          } else {
            const i = findLast(e.call, 'exec')
            if (i >= 0) next[i] = { call: e.call, name: e.name, phase: 'done', acc: e.result }
            else next.push({ call: e.call, name: e.name, phase: 'done', acc: e.result })
          }
          return next
        })
      }),
      window.mcl.onAiDone(() => {
        setAiStreaming('')
        refreshMods() // AI 可能装/删了 mod，顺手刷新
      }),
      window.mcl.onAiError(({ message: err }) => {
        setAiStreaming('')
        setAiMessages((msgs) => [...msgs, { role: 'assistant', text: `[错误] ${err}` }])
        setAiBusy(false)
      })
    ]
    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    aiChatRef.current?.scrollTo({ top: aiChatRef.current.scrollHeight })
  }, [aiMessages, aiStreaming, aiActivity])

  const onSaveAiConfig = () =>
    run(async () => {
      const saved = await window.mcl.setAiConfig({ baseUrl: aiBase.trim(), apiKey: aiKey.trim(), model: aiModel.trim() })
      setAiConfig(saved)
      setAiKey('')
      setMessage('')
    })

  const onAiSend = () =>
    run(async () => {
      const text = aiInput.trim()
      if (!text || aiBusy) return
      setAiInput('')
      setAiMessages((msgs) => [...msgs, { role: 'user', text }])
      setAiStreaming('')
      setAiActivity([]) // 新一轮提问：清掉上一轮的工具活动行
      setAiBusy(true)
      try {
        const { content } = await window.mcl.aiSend(text)
        setAiMessages((msgs) => [...msgs, { role: 'assistant', text: content }])
        setMessage('')
      } finally {
        // 失败（401/网络等）也必须恢复输入状态；错误文本经 onAiError 事件展示
        setAiBusy(false)
        setAiStreaming('')
      }
    })

  const onAiClear = () =>
    run(async () => {
      await window.mcl.aiClear()
      setAiMessages([])
      setAiStreaming('')
      setAiActivity([])
      setMessage('')
    })

  return {
    aiConfig,
    aiBase,
    setAiBase,
    aiKey,
    setAiKey,
    aiModel,
    setAiModel,
    aiMessages,
    aiStreaming,
    aiBusy,
    aiInput,
    setAiInput,
    aiActivity,
    aiChatRef,
    onSaveAiConfig,
    onAiSend,
    onAiClear
  }
}
