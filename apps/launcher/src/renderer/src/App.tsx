import { useState } from 'react'
import './App.css'

function App() {
  const [ping, setPing] = useState('')
  const [path, setPath] = useState('')
  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState(false)

  async function onPing() {
    setPing('…')
    setPing(await window.mcl.ping())
  }

  async function onSha1() {
    const target = path.trim()
    if (!target || busy) return
    setBusy(true)
    setHash('计算中…')
    try {
      setHash(await window.mcl.sha1(target))
    } catch (error) {
      setHash(`错误：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <span className="badge">M0 · 架构验证</span>
      <h1>MCL</h1>
      <p className="subtitle">AI 驱动的 Minecraft 启动器 · 当前为脚手架自检版</p>

      <section className="card">
        <h2>主进程连通性（IPC 自检）</h2>
        <div className="row">
          <button onClick={onPing}>Ping 主进程</button>
        </div>
        {ping && <div className="result">{ping}</div>}
      </section>

      <section className="card">
        <h2>核心库自检（@mcl/core 文件 SHA1）</h2>
        <div className="row">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="输入任意文件的绝对路径，例如 C:\Windows\win.ini"
          />
          <button onClick={onSha1} disabled={busy || !path.trim()}>
            计算 SHA1
          </button>
        </div>
        {hash && <div className="result">{hash}</div>}
      </section>

      <p className="footer">
        数据流：渲染进程 → preload（白名单 IPC）→ 主进程 → @mcl/core。下一步 M1：离线登录 +
        版本安装 + 原版启动。
      </p>
    </div>
  )
}

export default App
