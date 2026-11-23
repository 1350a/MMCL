import './App.css'
import { AccountsCard } from './components/AccountsCard'
import { AiCard } from './components/AiCard'
import { ExtManageCard } from './components/ExtManageCard'
import { ExtPanelsCard } from './components/ExtPanelsCard'
import { ExtReviewCard } from './components/ExtReviewCard'
import { InstancesCard } from './components/InstancesCard'
import { JavaCard } from './components/JavaCard'
import { ModsCard } from './components/ModsCard'
import { VersionsCard } from './components/VersionsCard'
import { useAccounts } from './hooks/useAccounts'
import { useAi } from './hooks/useAi'
import { useExtensions } from './hooks/useExtensions'
import { useGame } from './hooks/useGame'
import { useInstances } from './hooks/useInstances'
import { useJava } from './hooks/useJava'
import { useMods } from './hooks/useMods'
import { useRunner } from './hooks/useRunner'
import { useVersions } from './hooks/useVersions'

function App() {
  const { message, setMessage, run, needJavaMajor, setNeedJavaMajor } = useRunner()
  const accounts = useAccounts(run, setMessage)
  const java = useJava(run, setMessage, needJavaMajor, setNeedJavaMajor)
  const versions = useVersions(run, setMessage)
  const instances = useInstances(run, setMessage)
  const game = useGame()
  const mods = useMods(run, setMessage, instances.selectedInstance)
  const ai = useAi(run, setMessage, mods.refreshMods)
  const ext = useExtensions(run, setMessage)

  // 跨域动作（启动 / 绑定版本）
  const onLaunch = () =>
    run(async () => {
      game.setGameLines([])
      setNeedJavaMajor(null)
      await window.mcl.launchGame(instances.selectedInstance)
      game.setGameRunning(true)
      setMessage('')
    })

  const onBindVersion = () =>
    run(async () => {
      if (!instances.selectedInstance || !versions.selectedInstalled) return
      await window.mcl.setInstanceVersion(instances.selectedInstance, versions.selectedInstalled)
      instances.refreshInstances()
      setMessage('')
    })

  return (
    <>
      <div className="bg" aria-hidden="true" />
      <div className="app">
        <span className="badge">M6 · 多实例隔离 + AI 扩展</span>
        <h1>MCL</h1>
        <p className="subtitle">AI 驱动的 Minecraft 启动器 · 多实例隔离 + 版本/Fabric 安装 + AI 装 mod/写扩展/启动</p>

        <AccountsCard vm={accounts} />
        <JavaCard vm={java} />
        <VersionsCard vm={versions} />
        <InstancesCard
          vm={instances}
          game={game}
          versions={versions}
          java={java}
          needJavaMajor={needJavaMajor}
          account={accounts.account}
          onLaunch={onLaunch}
          onBindVersion={onBindVersion}
        />
        <ModsCard vm={mods} />
        <AiCard vm={ai} />
        {ext.pendingExt && (
          <ExtReviewCard pending={ext.pendingExt} onApprove={ext.onApproveExt} onReject={ext.onRejectExt} />
        )}
        <ExtManageCard vm={ext} />
        {ext.panels.length > 0 && <ExtPanelsCard panels={ext.panels} run={run} />}

        {message && <div className="error">{message}</div>}

        <p className="footer">
          数据流：渲染进程 → preload（白名单 IPC）→ 主进程（LauncherService）→ @mcl/core。
          离线 UUID 按官方算法生成；版本与资源来自 Mojang 官方源。
        </p>
      </div>
    </>
  )
}

export default App
