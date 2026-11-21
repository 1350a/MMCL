import { useEffect, useRef, useState } from 'react'
import './App.css'

function App() {
  // 账户
  const [account, setAccount] = useState<string>('')
  const [nameInput, setNameInput] = useState('')
  // Java 设置
  const [javaPath, setJavaPath] = useState('')
  const [javaInput, setJavaInput] = useState('')
  const [javaInfo, setJavaInfo] = useState<string>('')
  const [runtimes, setRuntimes] = useState<RuntimeInfoPayload[]>([])
  const [javaDl, setJavaDl] = useState<JavaInstallProgressPayload | null>(null)
  const [needJavaMajor, setNeedJavaMajor] = useState<number | null>(null)
  // 版本
  const [remoteVersions, setRemoteVersions] = useState<RemoteVersion[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  const [selectedRemote, setSelectedRemote] = useState('')
  const [selectedInstalled, setSelectedInstalled] = useState('')
  const [progress, setProgress] = useState<InstallProgressPayload | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  // 游戏
  const [gameRunning, setGameRunning] = useState(false)
  const [gameLines, setGameLines] = useState<string[]>([])
  const [message, setMessage] = useState('')
  // AI 面板
  const [aiConfig, setAiConfig] = useState<AiConfigPayload | null>(null)
  const [aiBase, setAiBase] = useState('')
  const [aiKey, setAiKey] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiMessages, setAiMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  const [aiStreaming, setAiStreaming] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiInput, setAiInput] = useState('')

  const logRef = useRef<HTMLDivElement>(null)
  const aiChatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 初始状态
    window.mcl.getAccount().then((a) => a && setAccount(a.name))
    window.mcl.getSettings().then((s) => {
      setJavaPath(s.javaPath)
      setJavaInput(s.javaPath)
      setJavaInfo(s.javaMajor ? `已探测：Java ${s.javaMajor}（${s.javaRaw}）` : s.javaPath ? '探测失败' : '')
    })
    window.mcl.listRemoteVersions().then(setRemoteVersions)
    window.mcl.listInstalledVersions().then(setInstalled)
    window.mcl.listRuntimes().then(setRuntimes)
    window.mcl.isGameRunning().then(setGameRunning)
    window.mcl.getAiConfig().then((c) => {
      setAiConfig(c)
      setAiBase(c.baseUrl)
      setAiModel(c.model)
    })

    const unsubs = [
      window.mcl.onInstallProgress((p) => setProgress(p)),
      window.mcl.onJavaInstallProgress((p) => setJavaDl(p)),
      window.mcl.onInstallDone((p) => {
        setInstalling(false)
        setProgress(null)
        if (p.ok) {
          setInstallError('')
          window.mcl.listInstalledVersions().then((list) => {
            setInstalled(list)
            setSelectedInstalled(p.id) // 装完即选中，可直接点启动
          })
        } else {
          setInstallError(p.error ?? '安装失败')
          window.mcl.listInstalledVersions().then(setInstalled)
        }
      }),
      window.mcl.onGameLog(({ line, source }) => {
        setGameLines((lines) => [...lines.slice(-2000), `[${source}] ${line}`])
      }),
      window.mcl.onGameExit(({ code }) => {
        setGameRunning(false)
        setGameLines((lines) => [...lines, `--- 游戏退出，退出码 ${code} ---`])
      }),
      window.mcl.onAiDelta(({ text }) => {
        setAiStreaming((s) => s + text)
      }),
      window.mcl.onAiDone(() => {
        setAiStreaming('')
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
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [gameLines])

  useEffect(() => {
    aiChatRef.current?.scrollTo({ top: aiChatRef.current.scrollHeight })
  }, [aiMessages, aiStreaming])

  async function run(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      const raw = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      const need = /需要 Java (\d+)/.exec(raw)
      if (need) setNeedJavaMajor(Number(need[1]))
      setMessage(raw)
    }
  }

  const onSaveAccount = () =>
    run(async () => {
      const saved = await window.mcl.saveAccount(nameInput.trim())
      setAccount(saved.name)
      setMessage('')
    })

  const onSaveJava = () =>
    run(async () => {
      const s = await window.mcl.setJavaPath(javaInput.trim())
      setJavaPath(s.javaPath)
      setJavaInfo(s.javaMajor ? `已探测：Java ${s.javaMajor}（${s.javaRaw}）` : '')
      setMessage('')
    })

  const onInstall = () =>
    run(async () => {
      setInstalling(true)
      setInstallError('')
      setProgress({ completed: 0, total: 0, file: '准备中…' })
      await window.mcl.installVersion(selectedRemote)
      setInstalling(false)
      setProgress(null)
    })

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
      setAiBusy(true)
      const { content } = await window.mcl.aiSend(text)
      setAiStreaming('')
      setAiMessages((msgs) => [...msgs, { role: 'assistant', text: content }])
      setAiBusy(false)
      setMessage('')
    })

  const onAiClear = () =>
    run(async () => {
      await window.mcl.aiClear()
      setAiMessages([])
      setAiStreaming('')
      setMessage('')
    })

  const onLaunch = () =>
    run(async () => {
      setGameLines([])
      setNeedJavaMajor(null)
      await window.mcl.launchGame(selectedInstalled)
      setGameRunning(true)
      setMessage('')
    })

  const onInstallRuntime = () =>
    run(async () => {
      if (needJavaMajor === null) return
      setMessage('')
      await window.mcl.installRuntime(needJavaMajor)
      setJavaDl(null)
      setNeedJavaMajor(null)
      window.mcl.listRuntimes().then(setRuntimes)
      setMessage(`Java ${needJavaMajor} 内置运行时已就绪，请再点一次启动`)
    })

  const releases = remoteVersions.filter((v) => v.type === 'release')

  return (
    <div className="app">
      <span className="badge">M1 · 能玩原版</span>
      <h1>MCL</h1>
      <p className="subtitle">AI 驱动的 Minecraft 启动器 · 离线账户 + 版本安装 + 原版启动</p>

      <section className="card">
        <h2>离线账户</h2>
        <div className="row">
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="玩家名（3-16 位字母/数字/下划线）"
          />
          <button onClick={onSaveAccount} disabled={!nameInput.trim()}>
            保存
          </button>
        </div>
        <div className="result">当前账户：{account || '未创建'}</div>
      </section>

      <section className="card">
        <h2>Java 运行时（本机路径）</h2>
        <div className="row">
          <input
            value={javaInput}
            onChange={(e) => setJavaInput(e.target.value)}
            placeholder="java.exe 路径或留空自动探测 PATH"
          />
          <button onClick={onSaveJava}>保存并探测</button>
        </div>
        {javaInfo && <div className="result">{javaInfo}</div>}
        <div className="result">
          内置运行时:{runtimes.length ? runtimes.map((r) => `Java ${r.major}`).join('、') : '（无，启动高版本时按引导下载）'}
        </div>
      </section>

      <section className="card">
        <h2>版本安装</h2>
        <div className="row">
          <select
            value={selectedRemote}
            onChange={(e) => setSelectedRemote(e.target.value)}
            disabled={remoteVersions.length === 0}
          >
            <option value="">{remoteVersions.length ? '选择版本…' : '清单加载中…'}</option>
            {releases.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
          <button onClick={onInstall} disabled={!selectedRemote || installing}>
            安装
          </button>
        </div>
        {progress && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${progress.total ? (progress.completed / progress.total) * 100 : 5}%` }} />
            <span className="progress-text">
              {progress.completed}/{progress.total} {progress.file}
            </span>
          </div>
        )}
        {installError && <div className="error">安装失败：{installError}</div>}
        <div className="result">已安装：{installed.length ? installed.join('、') : '（无）'}</div>
      </section>

      <section className="card">
        <h2>启动游戏</h2>
        <div className="row">
          <select value={selectedInstalled} onChange={(e) => setSelectedInstalled(e.target.value)}>
            <option value="">选择已安装版本…</option>
            {installed.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button onClick={onLaunch} disabled={!selectedInstalled || gameRunning || !account}>
            启动
          </button>
          <button onClick={() => window.mcl.stopGame()} disabled={!gameRunning}>
            停止
          </button>
        </div>
        <div className="log" ref={logRef}>
          {gameLines.length === 0 ? '游戏日志将显示在这里…' : gameLines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
        {needJavaMajor !== null && (
          <div className="java-need">
            <span>启动该版本需要 Java {needJavaMajor}（内置运行时约 45MB，不写入系统环境变量）</span>
            <button onClick={onInstallRuntime} disabled={!!javaDl}>
              {javaDl
                ? `${javaDl.phase === 'download' ? '下载' : '解压'} ${javaDl.completed}/${javaDl.total}`
                : `下载 Java ${needJavaMajor}`}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>AI 助手</h2>
        <div className="ai-config">
          <input value={aiBase} onChange={(e) => setAiBase(e.target.value)} placeholder="baseURL（如 https://api.deepseek.com）" />
          <input value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder={aiConfig?.apiKeyMasked || 'apiKey'} />
          <input value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="model（如 deepseek-chat）" />
          <button onClick={onSaveAiConfig}>保存配置</button>
        </div>
        <div className="log ai-chat" ref={aiChatRef}>
          {aiMessages.length === 0 && !aiStreaming ? '与 AI 助手对话（可让它列版本、分析崩溃日志）…' : (
            <>
              {aiMessages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'ai-user' : 'ai-assistant'}>
                  {m.role === 'user' ? '你' : 'AI'}：{m.text}
                </div>
              ))}
              {aiStreaming && <div className="ai-assistant">AI：{aiStreaming}</div>}
            </>
          )}
        </div>
        <div className="row">
          <input
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAiSend()}
            placeholder={aiConfig?.configured ? '向 AI 提问…' : '先配置 baseURL/apiKey/model'}
            disabled={aiBusy || !aiConfig?.configured}
          />
          <button onClick={onAiSend} disabled={aiBusy || !aiInput.trim() || !aiConfig?.configured}>
            {aiBusy ? '思考中…' : '发送'}
          </button>
          <button onClick={onAiClear} disabled={aiBusy}>清空会话</button>
        </div>
      </section>

      {message && <div className="error">{message}</div>}

      <p className="footer">
        数据流：渲染进程 → preload（白名单 IPC）→ 主进程（LauncherService）→ @mcl/core。
        离线 UUID 按官方算法生成；版本与资源来自 Mojang 官方源。
      </p>
    </div>
  )
}

export default App
