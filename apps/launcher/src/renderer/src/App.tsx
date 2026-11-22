import { useEffect, useRef, useState } from 'react'
import './App.css'

/** AI 工具活动行（干活过程可视化）。 */
interface AiActivityEntry {
  call: number
  name: string
  phase: 'args' | 'exec' | 'done'
  /** args 阶段累积的原始参数 / exec 的完整参数 / done 的结果。 */
  acc: string
}

function App() {
  // 账户
  const [account, setAccount] = useState<AccountPayload | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [authMode, setAuthMode] = useState<'offline' | 'yggdrasil'>('offline')
  const [serverInput, setServerInput] = useState('')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [profileChoices, setProfileChoices] = useState<ProfileChoice[] | null>(null)
  const [selectedProfile, setSelectedProfile] = useState('')
  const [skin, setSkin] = useState<SkinPayload | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
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
  // mods（M4）
  const [mods, setMods] = useState<ModFilePayload[]>([])
  const [modJarInput, setModJarInput] = useState('')
  // AI 面板
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
  // 扩展面板（M5-4）
  const [panels, setPanels] = useState<PanelStatePayload[]>([])
  // 扩展审核与管理（M5-5/6）
  const [pendingExt, setPendingExt] = useState<PendingExtensionPayload | null>(null)
  const [extensions, setExtensions] = useState<ExtensionSummaryPayload[]>([])

  const logRef = useRef<HTMLDivElement>(null)
  const aiChatRef = useRef<HTMLDivElement>(null)

  const refreshMods = (): void => {
    window.mcl.listMods().then(setMods)
  }

  useEffect(() => {
    // 初始状态
    window.mcl.getAccount().then((a) => setAccount(a))
    window.mcl.getSettings().then((s) => {
      setJavaPath(s.javaPath)
      setJavaInput(s.javaPath)
      setJavaInfo(s.javaMajor ? `已探测：Java ${s.javaMajor}（${s.javaRaw}）` : s.javaPath ? '探测失败' : '')
    })
    window.mcl.listRemoteVersions().then(setRemoteVersions)
    window.mcl.listInstalledVersions().then(setInstalled)
    window.mcl.listRuntimes().then(setRuntimes)
    window.mcl.isGameRunning().then(setGameRunning)
    refreshMods()
    window.mcl.getAiConfig().then((c) => {
      setAiConfig(c)
      setAiBase(c.baseUrl)
      setAiModel(c.model)
    })
    window.mcl.listPanels().then(setPanels)
    window.mcl.extPending().then(setPendingExt)
    window.mcl.extList().then(setExtensions)

    const unsubs = [
      window.mcl.onInstallProgress((p) => setProgress(p)),
      window.mcl.onJavaInstallProgress((p) => setJavaDl(p)),
      window.mcl.onAccountChanged((a) => {
        setAccount(a)
        setProfileChoices(null)
        setAuthPassword('')
        setSelectedProfile('')
      }),
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
      }),
      window.mcl.onPanelChanged((list) => setPanels(list)),
      window.mcl.onExtPending((p) => setPendingExt(p)),
      window.mcl.onExtListChanged((list) => setExtensions(list))
    ]
    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [gameLines])

  // 外置账户变化时刷新皮肤头像
  useEffect(() => {
    if (account?.kind !== 'yggdrasil') {
      setSkin(null)
      return
    }
    window.mcl.fetchSkin().then((s) => setSkin(s))
  }, [account])

  useEffect(() => {
    aiChatRef.current?.scrollTo({ top: aiChatRef.current.scrollHeight })
  }, [aiMessages, aiStreaming, aiActivity])

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
      await window.mcl.saveAccount(nameInput.trim())
      setAccount(await window.mcl.getAccount())
      setMessage('')
    })

  const onYggdrasilLogin = () =>
    run(async () => {
      setLoggingIn(true)
      try {
        const result = await window.mcl.yggdrasilLogin(serverInput.trim(), authUsername.trim(), authPassword)
        if (result.status === 'select-profile') {
          setProfileChoices(result.profiles)
          setSelectedProfile(result.profiles[0]?.id ?? '')
          setMessage('')
        }
        // status ok 时账户经 event:account-changed 事件回填
      } finally {
        setLoggingIn(false)
      }
    })

  const onSelectProfile = () =>
    run(async () => {
      setLoggingIn(true)
      try {
        await window.mcl.selectProfile(selectedProfile)
        setProfileChoices(null)
        setMessage('')
      } finally {
        setLoggingIn(false)
      }
    })

  const onLogout = () =>
    run(async () => {
      await window.mcl.logoutAccount()
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

  const onCancelInstall = () =>
    run(async () => {
      await window.mcl.cancelInstall()
      setMessage('安装取消中…')
    })

  const onCancelRuntime = () =>
    run(async () => {
      await window.mcl.cancelRuntimeInstall()
      setJavaDl(null) // 取消后不再有进度事件，本地恢复下载按钮
      setMessage('运行时下载已取消（.part 已下部分保留，重下时续传）')
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

  const onLaunch = () =>
    run(async () => {
      setGameLines([])
      setNeedJavaMajor(null)
      await window.mcl.launchGame(selectedInstalled)
      setGameRunning(true)
      setMessage('')
    })

  const onInstallFabric = () =>
    run(async () => {
      if (!selectedInstalled) return
      setInstalling(true)
      setInstallError('')
      setProgress({ completed: 0, total: 0, file: '准备 Fabric…' })
      await window.mcl.installFabric(selectedInstalled)
      // 完成后经 event:install-done 刷新版本列表并选中新 fabric 版本
    })

  const onRemoveMod = (filename: string) =>
    run(async () => {
      await window.mcl.removeMod(filename)
      refreshMods()
      setMessage('')
    })

  const onInstallLocalMod = () =>
    run(async () => {
      if (!modJarInput.trim()) return
      await window.mcl.installModLocal(modJarInput.trim())
      setModJarInput('')
      refreshMods()
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

  const onApproveExt = () =>
    run(async () => {
      await window.mcl.extApprove()
      setMessage('')
    })

  const onRejectExt = () =>
    run(async () => {
      await window.mcl.extReject()
      setMessage('')
    })

  const onRemoveExt = (id: string) =>
    run(async () => {
      await window.mcl.extRemove(id)
      setMessage('')
    })

  const releases = remoteVersions.filter((v) => v.type === 'release')

  return (
    <div className="app">
      <span className="badge">M4 · 智能体操作 + Fabric</span>
      <h1>MCL</h1>
      <p className="subtitle">AI 驱动的 Minecraft 启动器 · 离线/外置账户 + 版本/Fabric 安装 + AI 装 mod/改配置/启动</p>

      <section className="card">
        <h2>账户</h2>
        {!account && (
          <div className="row">
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as 'offline' | 'yggdrasil')}>
              <option value="offline">离线登录</option>
              <option value="yggdrasil">外置登录（authlib-injector）</option>
            </select>
          </div>
        )}
        {!account && authMode === 'offline' && (
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
        )}
        {!account && authMode === 'yggdrasil' && (
          <>
            <div className="row">
              <input
                value={serverInput}
                onChange={(e) => setServerInput(e.target.value)}
                placeholder="认证服务器地址（API 根或首页，如 skin.example.com）"
              />
            </div>
            {serverInput.trim().startsWith('http://') && (
              <div className="error">警告：该服务器使用明文 HTTP，密码将不加密传输，存在安全风险</div>
            )}
            <div className="row">
              <input
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                placeholder="账号（邮箱或用户名，以服务器要求为准）"
              />
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onYggdrasilLogin()}
                placeholder="密码"
              />
              <button
                onClick={onYggdrasilLogin}
                disabled={!serverInput.trim() || !authUsername.trim() || !authPassword || loggingIn}
              >
                {loggingIn ? '登录中…' : '登录'}
              </button>
            </div>
            {profileChoices && (
              <div className="row">
                <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)}>
                  {profileChoices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button onClick={onSelectProfile} disabled={!selectedProfile || loggingIn}>
                  确认角色
                </button>
              </div>
            )}
          </>
        )}
        {account && (
          <div className="row">
            {skin && (
              <img
                src={skin.url}
                alt="皮肤"
                style={{ height: 64, imageRendering: 'pixelated' }}
              />
            )}
            <div className="result" style={{ flex: 1 }}>
              当前账户：
              {account.kind === 'yggdrasil' ? (
                <>
                  {account.name}（外置 ·{' '}
                  <span title={account.apiRoot}>{account.serverName ?? account.apiRoot}</span>）
                </>
              ) : (
                `${account.name}（离线）`
              )}
            </div>
            <button onClick={onLogout}>登出</button>
          </div>
        )}
        {!account && <div className="result">当前账户：未创建</div>}
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
          {installing && (
            <button onClick={onCancelInstall}>取消</button>
          )}
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
            {javaDl && <button onClick={onCancelRuntime}>取消</button>}
          </div>
        )}
        <div className="row">
          <button
            onClick={onInstallFabric}
            disabled={!selectedInstalled || installing || selectedInstalled.startsWith('fabric-loader-')}
            title={
              selectedInstalled.startsWith('fabric-loader-')
                ? '该版本已是 Fabric 版本'
                : '为选中的原版版本安装最新稳定版 Fabric 加载器'
            }
          >
            装 Fabric
          </button>
          <span className="result" style={{ flex: 1 }}>
            {selectedInstalled.startsWith('fabric-loader-')
              ? '已选 Fabric 版本，可直接启动'
              : '为原版版本装上 Fabric 后，就能在 mods 目录使用 mod'}
          </span>
        </div>
      </section>

      <section className="card">
        <h2>Mods（instances/main/mods）</h2>
        <div className="row">
          <input
            value={modJarInput}
            onChange={(e) => setModJarInput(e.target.value)}
            placeholder="本地 mod jar 路径（也可让 AI 从 Modrinth 安装）"
          />
          <button onClick={onInstallLocalMod} disabled={!modJarInput.trim()}>
            安装本地 mod
          </button>
        </div>
        <div className="result">
          {mods.length
            ? mods.map((m) => (
                <div key={m.filename} className="row">
                  <span style={{ flex: 1 }}>
                    {m.filename}（{(m.sizeBytes / 1024).toFixed(0)} KB）
                  </span>
                  <button onClick={() => onRemoveMod(m.filename)}>删除</button>
                </div>
              ))
            : '（mods 目录为空——可以在 AI 助手里说「帮我装 XX mod」）'}
        </div>
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
          {aiMessages.length === 0 && !aiStreaming && aiActivity.length === 0
            ? '与 AI 助手对话（装 mod、改设置、启动游戏、写扩展、分析崩溃日志）…'
            : (
            <>
              {aiMessages.map((m, i) => (
                <div key={i} className={m.role === 'user' ? 'ai-user' : 'ai-assistant'}>
                  {m.role === 'user' ? '你' : 'AI'}：{m.text}
                </div>
              ))}
              {aiActivity.map((a, i) => (
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

      {pendingExt && (
        <section className="card">
          <h2>扩展审核（AI 提案）</h2>
          <div className="result">
            {pendingExt.manifest.id} · {pendingExt.manifest.name}
            {pendingExt.manifest.version ? ` · v${pendingExt.manifest.version}` : ''}
            {pendingExt.manifest.requires?.length ? ` · 依赖：${pendingExt.manifest.requires.join('、')}` : ''}
          </div>
          <div className="ext-chips">
            {pendingExt.manifest.capabilities.map((c) => (
              <span key={c} className={`chip${c === 'fs.instance' || c === 'net.domains' ? ' chip-warn' : ''}`}>
                {c}
              </span>
            ))}
          </div>
          {(pendingExt.manifest.fsInstances?.length || pendingExt.manifest.netDomains?.length) && (
            <div className="result">
              {pendingExt.manifest.fsInstances?.length ? `fs 作用域：${pendingExt.manifest.fsInstances.join('、')}　` : ''}
              {pendingExt.manifest.netDomains?.length ? `net 白名单：${pendingExt.manifest.netDomains.join('、')}` : ''}
            </div>
          )}
          <div className="log ext-code">{pendingExt.code}</div>
          <div className="row">
            <button onClick={onApproveExt}>批准并装载</button>
            <button onClick={onRejectExt}>拒绝</button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>扩展管理</h2>
        {extensions.length ? (
          extensions.map((e) => (
            <div key={e.id} className="ext-row">
              <div className="row">
                <span style={{ flex: 1 }}>
                  <b>{e.id}</b> · {e.name}
                  {e.version ? ` · v${e.version}` : ''}（{e.state === 'active' ? '运行中' : '已停用'}）
                </span>
                <button onClick={() => onRemoveExt(e.id)}>移除</button>
              </div>
              <div className="ext-chips">
                {e.capabilities.map((c) => (
                  <span key={c} className={`chip${c === 'fs.instance' || c === 'net.domains' ? ' chip-warn' : ''}`}>
                    {c}
                  </span>
                ))}
              </div>
              {(e.fsInstances?.length || e.netDomains?.length) && (
                <div className="result">
                  {e.fsInstances?.length ? `fs：${e.fsInstances.join('、')}　` : ''}
                  {e.netDomains?.length ? `net：${e.netDomains.join('、')}` : ''}
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="result">（无扩展——对 AI 说「帮我写一个扩展」来生成，批准后在这里管理）</div>
        )}
      </section>

      {panels.length > 0 && (
        <section className="card">
          <h2>扩展面板</h2>
          {panels.map((panel) => (
            <div key={panel.id} className="ext-panel">
              <h3>{panel.title}</h3>
              {panel.items.map((item, i) => {
                if (item.type === 'text') {
                  return (
                    <p key={i} className="ext-text">
                      {item.content}
                    </p>
                  )
                }
                if (item.type === 'kv') {
                  return (
                    <div key={i} className="ext-kv">
                      {Object.entries(item.rows ?? {}).map(([k, v]) => (
                        <div key={k} className="ext-kv-row">
                          <span>{k}</span>
                          <b>{v}</b>
                        </div>
                      ))}
                    </div>
                  )
                }
                if (item.type === 'button') {
                  return (
                    <button
                      key={i}
                      className="ext-btn"
                      onClick={() =>
                        run(async () => {
                          await window.mcl.panelAction(panel.id, item.action ?? '')
                        })
                      }
                    >
                      {item.label}
                    </button>
                  )
                }
                return null
              })}
            </div>
          ))}
        </section>
      )}

      {message && <div className="error">{message}</div>}

      <p className="footer">
        数据流：渲染进程 → preload（白名单 IPC）→ 主进程（LauncherService）→ @mcl/core。
        离线 UUID 按官方算法生成；版本与资源来自 Mojang 官方源。
      </p>
    </div>
  )
}

export default App
