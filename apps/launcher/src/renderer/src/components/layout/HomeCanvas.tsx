import { useEffect, useState } from 'react'
import type { useAi } from '../../hooks/useAi'

/**
 * 主页中心区（UI-DESIGN.md §2.1）：默认 = AI 对话面板。
 * 未配置 key → 引导面板（内联配置或暂不使用）；AI 禁用 → 留白（仅背景透出）。
 */
export function HomeCanvas({
  ai,
  onNavigateSettings
}: {
  ai: ReturnType<typeof useAi>
  onNavigateSettings: () => void
}) {
  const [aiDisabled, setAiDisabled] = useState<boolean | null>(null)

  useEffect(() => {
    void window.mcl.getConfig().then((c) => setAiDisabled(c.ui?.aiDisabled ?? false))
  }, [ai.aiConfig])

  const setAiEnabled = async (enabled: boolean): Promise<void> => {
    await window.mcl.setConfig({ ui: { aiDisabled: !enabled } })
    setAiDisabled(!enabled)
  }

  // 配置读取中
  if (aiDisabled === null) return <div className="home" />

  // AI 已禁用：留白艺术（仅背景透出）+ 角落启用入口
  if (aiDisabled && !ai.aiConfig?.configured) {
    return (
      <div className="home home-blank">
        <button
          className="home-enable"
          onClick={() => void setAiEnabled(true)}
          title="重新启用 AI 助手"
        >
          启用 AI 助手
        </button>
      </div>
    )
  }

  // 未配置 key：引导面板（仅首次引导；配置表单内联）
  if (!ai.aiConfig?.configured) {
    return (
      <div className="home">
        <div className="home-guide">
          <h1 className="home-title">启用 AI 助手</h1>
          <p className="home-guide-sub">配置 API 后可让 AI 装 mod、改设置、启动游戏、写扩展、分析崩溃日志</p>
          <div className="home-guide-form">
            <input value={ai.aiBase} onChange={(e) => ai.setAiBase(e.target.value)} placeholder="baseURL（如 https://api.deepseek.com）" />
            <input type="password" value={ai.aiKey} onChange={(e) => ai.setAiKey(e.target.value)} placeholder={ai.aiConfig?.apiKeyMasked || 'apiKey'} />
            <input value={ai.aiModel} onChange={(e) => ai.setAiModel(e.target.value)} placeholder="model（如 deepseek-chat）" />
            <button className="home-send" onClick={ai.onSaveAiConfig}>
              保存配置
            </button>
            <button className="home-later" onClick={() => void setAiEnabled(false)}>
              暂不使用
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 默认：AI 对话面板（一句标题 + 聊天流 + 输入行：发送圆钮 + 模型下拉）
  return (
    <div className="home">
      <h1 className="home-title">AI 助手</h1>
      <div className="log ai-chat home-chat" ref={ai.aiChatRef}>
        {ai.aiMessages.length === 0 && !ai.aiStreaming && ai.aiActivity.length === 0 ? (
          <span className="home-chat-hint">向 AI 提问：装 mod、改设置、启动游戏、写扩展、分析崩溃日志…</span>
        ) : (
          <>
            {ai.aiMessages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'ai-user' : 'ai-assistant'}>
                {m.role === 'user' ? '你' : 'AI'}：{m.text}
              </div>
            ))}
            {ai.aiActivity.map((a, i) => (
              <div key={`act-${i}`} className="ai-activity">
                {a.phase === 'args' && (
                  <>
                    ⚙ {a.name || '工具'} 生成参数中：{a.acc.length > 160 ? '…' : ''}
                    {a.acc.slice(-160)}
                  </>
                )}
                {a.phase === 'exec' && <>⚙ 执行 {a.name}…</>}
                {a.phase === 'done' && <>✓ {a.name} 完成</>}
              </div>
            ))}
            {ai.aiStreaming && <div className="ai-assistant">AI：{ai.aiStreaming}</div>}
          </>
        )}
      </div>
      <div className="home-input-row">
        <input
          className="home-input"
          value={ai.aiInput}
          onChange={(e) => ai.setAiInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ai.onAiSend()}
          placeholder="向 AI 提问…"
          disabled={ai.aiBusy}
        />
        <button className="home-clear" onClick={ai.onAiClear} disabled={ai.aiBusy} title="清空会话">
          清空
        </button>
        <ModelMenu model={ai.aiConfig.model} onNavigateSettings={onNavigateSettings} />
        <button className="home-send home-send-circle" onClick={ai.onAiSend} disabled={ai.aiBusy || !ai.aiInput.trim()} title="发送">
          ➤
        </button>
      </div>
    </div>
  )
}

/** 模型下拉：显示当前模型 + 「配置模型」跳设置页（§2.1 输入框右下角）。 */
function ModelMenu({ model, onNavigateSettings }: { model: string; onNavigateSettings: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="model-menu">
      <button className="home-model" onClick={() => setOpen((v) => !v)} title="选择模型">
        {model || '选择模型'} ▾
      </button>
      {open && (
        <div className="bb-menu bb-menu-up model-menu-list">
          <div className="bb-menu-row">
            <button className="bb-menu-main bb-menu-active">{model || '（未设置）'}</button>
          </div>
          <button
            className="bb-menu-add"
            onClick={() => {
              setOpen(false)
              onNavigateSettings()
            }}
          >
            ⚙ 配置模型
          </button>
        </div>
      )}
    </div>
  )
}
