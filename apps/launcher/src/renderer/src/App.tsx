import { useEffect, useState } from 'react'
import './App.css'
import { ToastStack } from './components/ui/Toast'
import type { ToastItem } from './hooks/useTasks'
import { TitleBar } from './components/layout/TitleBar'
import { SideBar } from './components/layout/SideBar'
import { BottomBar } from './components/layout/BottomBar'
import { HomeCanvas } from './components/layout/HomeCanvas'
import { LoginMethodDialog } from './components/dialogs/LoginMethodDialog'
import { ConfirmDialog } from './components/dialogs/ConfirmDialog'
import { ErrorDialog } from './components/dialogs/ErrorDialog'
import { GameLogDialog } from './components/dialogs/GameLogDialog'
import { VersionSettingsDialog } from './components/dialogs/VersionSettingsDialog'
import { NewInstanceDialog } from './components/dialogs/NewInstanceDialog'
import { PlaceholderPage } from './components/pages/PlaceholderPage'
import { NavigationProvider, useNavigation } from './state/AppState'
import { useAccounts } from './hooks/useAccounts'
import { useAi } from './hooks/useAi'
import { useExtensions } from './hooks/useExtensions'
import { useGame } from './hooks/useGame'
import { useInstances } from './hooks/useInstances'
import { useJava } from './hooks/useJava'
import { useMods } from './hooks/useMods'
import { useRunner } from './hooks/useRunner'
import { useTasks } from './hooks/useTasks'
import { useVersions } from './hooks/useVersions'

interface ConfirmState {
  title: string
  body: string
  danger?: boolean
  confirmLabel?: string
  onConfirm: () => void
}

function App() {
  return (
    <NavigationProvider>
      <LauncherShell />
    </NavigationProvider>
  )
}

/** 三大件装配（UI-DESIGN.md §1）：顶栏 + 侧栏 + 底栏 + 页面中心区。 */
function LauncherShell() {
  const { page, navigate, sidebarCollapsed, toggleSidebar } = useNavigation()
  const { message, setMessage, run, needJavaMajor, setNeedJavaMajor } = useRunner()
  const accounts = useAccounts(run, setMessage)
  const java = useJava(run, setMessage, needJavaMajor, setNeedJavaMajor)
  const versions = useVersions(run, setMessage)
  const instances = useInstances(run, setMessage)
  const game = useGame()
  const mods = useMods(run, setMessage, instances.selectedInstance)
  const ai = useAi(run, setMessage, mods.refreshMods)
  const ext = useExtensions(run, setMessage)
  const tasks = useTasks()

  const [loginOpen, setLoginOpen] = useState(false)
  const [versionSettingsFor, setVersionSettingsFor] = useState<InstanceMetaPayload | null>(null)
  const [newInstanceOpen, setNewInstanceOpen] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [errorState, setErrorState] = useState<{ title: string; detail: string } | null>(null)
  const [logOpen, setLogOpen] = useState(false)

  // 全局操作错误 → 通知（§6 过程反馈走通知）
  useEffect(() => {
    if (message) {
      tasks.pushToast({ kind: 'error', title: '操作失败', body: message })
      setMessage('')
    }
  }, [message])

  // 启动缺 Java → 带一键下载动作的通知（替代旧 java-need 横幅）。
  // 注意不清 needJavaMajor：动作按钮点击时 onInstallRuntime 依赖它，成功后自清
  useEffect(() => {
    if (needJavaMajor === null) return
    tasks.pushToast({
      kind: 'warning',
      title: `启动需要 Java ${needJavaMajor}`,
      body: '内置运行时约 45MB，不写入系统环境变量',
      actions: [{ id: 'install-runtime', label: `下载 Java ${needJavaMajor}` }]
    })
  }, [needJavaMajor])

  // 通知动作按钮分发（§6 可带动作按钮）
  const handleAction = (toast: ToastItem, actionId: string): void => {
    if (actionId === 'open-log') setLogOpen(true)
    else if (actionId === 'install-runtime') java.onInstallRuntime()
    tasks.dismissToast(toast.id)
  }

  const onLaunch = () =>
    run(async () => {
      game.setGameLines([])
      setNeedJavaMajor(null)
      await window.mcl.launchGame(instances.selectedInstance)
      game.setGameRunning(true)
      tasks.upsertTask({
        id: 'game',
        title: `游戏运行（${instances.selectedMeta?.name ?? ''}）`,
        kind: 'game',
        status: 'running'
      })
      setMessage('')
    })

  // 删除版本确认（弹窗时机②：隔离数据随删的告知内嵌在正文；设置弹窗自行走退场动画）
  const requestDeleteInstance = (inst: InstanceMetaPayload): void => {
    setConfirmState({
      title: '删除版本',
      body: `删除版本「${inst.name}」不可恢复。若该版本按策略处于隔离状态，其存档 / mods / 设置将一并删除；未隔离的版本仅移除条目，根目录存档与 mods 不受影响。版本本体在无其他引用时自动清理（可在设置关闭）。`,
      danger: true,
      confirmLabel: '删除',
      onConfirm: () => {
        void (async () => {
          try {
            const result = await window.mcl.deleteInstance(inst.id)
            instances.refreshInstances()
            tasks.pushToast({
              kind: 'info',
              title: `版本「${inst.name}」已删除`,
              body: `${result.dataDeleted ? '隔离数据随条目删除；' : '仅移除条目，根目录数据未动；'}${result.versionCleaned ? '版本本体已自动清理。' : '版本本体保留。'}`
            })
          } catch (err) {
            setErrorState({ title: '删除失败', detail: (err as Error).message })
          }
        })()
      }
    })
  }

  const recentChats = ai.aiMessages.filter((m) => m.role === 'user').slice(-5).map((m) => m.text)

  return (
    <>
      <div className="bg" aria-hidden="true" />
      <div className="shell">
        <SideBar
          collapsed={sidebarCollapsed}
          tasks={tasks.tasks}
          recent={recentChats}
          onPickRecent={(text) => ai.setAiInput(text)}
        />
        <div className="main-col">
          <TitleBar />
          <div className="page-area">
            {page === 'home' && <HomeCanvas ai={ai} onNavigateSettings={() => navigate('settings')} />}
            {page === 'download' && <PlaceholderPage title="下载" note="版本 / Java / Mod 管理将在下一步接入（C6）" />}
            {page === 'extensions' && <PlaceholderPage title="插件" note="扩展审核与管理将在 C8 接入" />}
            {page === 'settings' && <PlaceholderPage title="设置" note="外观 / 版本与隔离 / Java / 网络 / 通用将在 C7 接入" />}
          </div>
          <BottomBar
            accounts={accounts}
            instances={instances}
            game={game}
            onLaunch={onLaunch}
            onOpenLogin={() => setLoginOpen(true)}
            onOpenVersionSettings={(inst) => setVersionSettingsFor(inst)}
            onOpenNewInstance={() => setNewInstanceOpen(true)}
            onConfirm={(req) => setConfirmState(req)}
            navigate={navigate}
          />
        </div>
      </div>

      {/* 收起态挂件按钮（顶栏下方左上角，§2.2） */}
      {sidebarCollapsed && (
        <button className="sidebar-restorer" onClick={toggleSidebar} title="展开侧栏（Ctrl+B）">
          »
        </button>
      )}

      <ToastStack toasts={tasks.toasts} onDismiss={tasks.dismissToast} onAction={handleAction} />

      {loginOpen && <LoginMethodDialog vm={accounts} onClose={() => setLoginOpen(false)} />}
      {versionSettingsFor && (
        <VersionSettingsDialog
          instance={versionSettingsFor}
          versions={versions}
          instances={instances}
          onDeleteRequest={requestDeleteInstance}
          onClose={() => setVersionSettingsFor(null)}
        />
      )}
      {newInstanceOpen && (
        <NewInstanceDialog instances={instances} versions={versions} onClose={() => setNewInstanceOpen(false)} />
      )}
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          body={confirmState.body}
          danger={confirmState.danger}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}
      {errorState && (
        <ErrorDialog title={errorState.title} detail={errorState.detail} onClose={() => setErrorState(null)} />
      )}
      {logOpen && <GameLogDialog lines={game.gameLines} onClose={() => setLogOpen(false)} />}
    </>
  )
}

export default App
