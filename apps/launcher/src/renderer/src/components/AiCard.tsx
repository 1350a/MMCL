import type { useAi } from '../hooks/useAi'

/** AI 助手卡：配置、对话流、工具活动与输入。 */
export function AiCard({ vm }: { vm: ReturnType<typeof useAi> }) {
  return (
    <section className="card">
      <h2>AI 助手</h2>
      <div className="ai-config">
        <input value={vm.aiBase} onChange={(e) => vm.setAiBase(e.target.value)} placeholder="baseURL（如 https://api.deepseek.com）" />
        <input value={vm.aiKey} onChange={(e) => vm.setAiKey(e.target.value)} placeholder={vm.aiConfig?.apiKeyMasked || 'apiKey'} />
        <input value={vm.aiModel} onChange={(e) => vm.setAiModel(e.target.value)} placeholder="model（如 deepseek-chat）" />
        <button onClick={vm.onSaveAiConfig}>保存配置</button>
      </div>
      <div className="log ai-chat" ref={vm.aiChatRef}>
        {vm.aiMessages.length === 0 && !vm.aiStreaming && vm.aiActivity.length === 0
          ? '与 AI 助手对话（装 mod、改设置、启动游戏、写扩展、分析崩溃日志）…'
          : (
          <>
            {vm.aiMessages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'ai-user' : 'ai-assistant'}>
                {m.role === 'user' ? '你' : 'AI'}：{m.text}
              </div>
            ))}
            {vm.aiActivity.map((a, i) => (
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
            {vm.aiStreaming && <div className="ai-assistant">AI：{vm.aiStreaming}</div>}
          </>
        )}
      </div>
      <div className="row">
        <input
          value={vm.aiInput}
          onChange={(e) => vm.setAiInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && vm.onAiSend()}
          placeholder={vm.aiConfig?.configured ? '向 AI 提问…' : '先配置 baseURL/apiKey/model'}
          disabled={vm.aiBusy || !vm.aiConfig?.configured}
        />
        <button onClick={vm.onAiSend} disabled={vm.aiBusy || !vm.aiInput.trim() || !vm.aiConfig?.configured}>
          {vm.aiBusy ? '思考中…' : '发送'}
        </button>
        <button onClick={vm.onAiClear} disabled={vm.aiBusy}>清空会话</button>
      </div>
    </section>
  )
}
