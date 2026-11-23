/// <reference types="vite/client" />

interface RemoteVersion {
  id: string
  type: string
  releaseTime: string
}

interface SettingsPayload {
  javaPath: string
  javaMajor?: number
  javaRaw?: string
}

interface OfflineAccountPayload {
  kind: 'offline'
  name: string
  uuid: string
}

/** 渲染进程可见的 Yggdrasil 账户（不含 accessToken/clientToken）。 */
interface YggdrasilAccountPayload {
  kind: 'yggdrasil'
  name: string
  uuid: string
  apiRoot: string
  serverName?: string
}

type AccountPayload = OfflineAccountPayload | YggdrasilAccountPayload

interface ProfileChoice {
  id: string
  name: string
}

type YggdrasilLoginResult = { status: 'ok' } | { status: 'select-profile'; profiles: ProfileChoice[] }

interface SkinPayload {
  url: string
  model?: 'default' | 'slim'
}

interface InstallProgressPayload {
  completed: number
  total: number
  file: string
}

interface InstallDonePayload {
  id: string
  ok: boolean
  error?: string
}

interface GameLogPayload {
  line: string
  source: 'stdout' | 'stderr'
}

interface GameExitPayload {
  code: number | null
}

// 游戏实例（M6 多实例；C5 加每版本隔离策略）
interface InstanceMetaPayload {
  id: string
  name: string
  versionId?: string
  /** 缺省 = 跟随全局。 */
  isolation?: 'follow' | 'all' | 'none' | 'snapshotOnly' | 'modOnly' | 'snapshotAndMod'
  createdAt?: string
}

/** 账号列表项（多账户切换；id = uuid 优先、离线回退玩家名）。 */
type AccountListItemPayload = AccountPayload & { id: string }

/** 删除版本条目结果（据实告知：数据是否随删、本体是否清理）。 */
interface DeleteInstanceResultPayload {
  dataDeleted: boolean
  versionCleaned: boolean
}

/** 右下角通知（UI-DESIGN.md §6）；动作由渲染层按 id 分发。 */
interface NotifyPayload {
  id: string
  title: string
  body?: string
  kind: 'info' | 'success' | 'warning' | 'error'
  actions?: Array<{ id: string; label: string }>
}

type Unsubscribe = () => void

interface RuntimeInfoPayload {
  major: number
  javaPath: string
}

interface JavaInstallProgressPayload {
  phase: 'download' | 'extract'
  completed: number
  total: number
  file: string
}

interface AiConfigPayload {
  baseUrl: string
  apiKeyMasked: string
  model: string
  configured: boolean
}

interface AiDeltaPayload {
  text: string
}

interface AiDonePayload {
  content: string
}

interface AiErrorPayload {
  message: string
}

// AI 工具活动（干活过程可视化）：参数流式生成 → 执行 → 完成
type AiToolEventPayload =
  | { kind: 'args'; call: number; name: string; delta: string }
  | { kind: 'exec'; call: number; name: string; args: string }
  | { kind: 'done'; call: number; name: string; result: string }

interface ModFilePayload {
  filename: string
  sizeBytes: number
}

interface OptionEntry {
  key: string
  value: string
}

// 扩展面板（M5-4）：声明式三元素，宿主渲染
interface PanelItemPayload {
  type: 'text' | 'kv' | 'button'
  content?: string
  rows?: Record<string, string>
  label?: string
  action?: string
}

interface PanelStatePayload {
  id: string
  title: string
  items: PanelItemPayload[]
}

// 扩展审核/管理（M5-5/6）
interface PendingExtensionPayload {
  manifest: {
    id: string
    name: string
    version?: string
    capabilities: string[]
    requires?: string[]
    fsInstances?: string[]
    netDomains?: string[]
  }
  code: string
}

interface ExtensionSummaryPayload {
  id: string
  name: string
  version?: string
  capabilities: string[]
  fsInstances?: string[]
  netDomains?: string[]
  state: 'active' | 'inactive'
}

interface SubmitResultPayload {
  ok: true
  id: string
  message: string
}

/** UI 偏好（外观类设置）。 */
interface UiPrefsPayload {
  sidebarHidden?: boolean
  backgroundPath?: string
  /** 禁用 AI（主页留白态）。 */
  aiDisabled?: boolean
}

/** 全局配置（渲染层可见形态：AI key 只出掩码）。 */
interface ConfigPayload {
  lastGameRoot?: string
  lastVersionId?: string
  javaPath?: string
  ai?: { baseUrl: string; model: string; apiKeyMasked: string }
  updates?: 'auto' | 'notify' | 'notifyImportant' | 'off'
  autoCleanupVersions?: boolean
  downloadSource?: 'official' | 'bmclapi'
  ui?: UiPrefsPayload
}

/** 可修改的配置子集（javaPath 空串 = 清除手动路径）。 */
interface ConfigPatchPayload {
  javaPath?: string
  updates?: 'auto' | 'notify' | 'notifyImportant' | 'off'
  autoCleanupVersions?: boolean
  downloadSource?: 'official' | 'bmclapi'
  ui?: UiPrefsPayload
}

/** Splash 管线进度（UI-DESIGN.md §5）。 */
interface SplashProgressPayload {
  step: number
  total: number
  label: string
  detail?: string
  state: 'running' | 'done' | 'error' | 'background' | 'skipped'
}

interface MclApi {
  ping: () => Promise<string>
  sha1: (filePath: string) => Promise<string>

  getSettings: () => Promise<SettingsPayload>
  setJavaPath: (javaPath: string) => Promise<SettingsPayload>
  getConfig: () => Promise<ConfigPayload>
  setConfig: (patch: ConfigPatchPayload) => Promise<ConfigPayload>
  getAccount: () => Promise<AccountPayload | null>
  saveAccount: (name: string) => Promise<OfflineAccountPayload>
  listAccounts: () => Promise<AccountListItemPayload[]>
  switchAccount: (id: string) => Promise<AccountPayload | null>
  deleteAccount: (id: string) => Promise<void>

  yggdrasilLogin: (server: string, username: string, password: string) => Promise<YggdrasilLoginResult>
  selectProfile: (profileId: string) => Promise<void>
  logoutAccount: () => Promise<void>
  fetchSkin: () => Promise<SkinPayload | null>

  listRemoteVersions: () => Promise<RemoteVersion[]>
  listInstalledVersions: () => Promise<string[]>
  installVersion: (id: string) => Promise<void>
  cancelInstall: () => Promise<void>

  listRuntimes: () => Promise<RuntimeInfoPayload[]>
  installRuntime: (major: number) => Promise<RuntimeInfoPayload>
  cancelRuntimeInstall: () => Promise<void>

  launchGame: (id: string) => Promise<{ logFile: string }>
  stopGame: () => Promise<void>
  readGameLog: () => Promise<string>
  isGameRunning: () => Promise<boolean>

  listInstances: () => Promise<InstanceMetaPayload[]>
  createInstance: (input: { id?: string; name: string; versionId?: string }) => Promise<InstanceMetaPayload>
  setInstanceVersion: (instanceId: string, versionId: string) => Promise<InstanceMetaPayload>
  updateInstance: (instanceId: string, patch: { name?: string; isolation?: string }) => Promise<InstanceMetaPayload>
  deleteInstance: (instanceId: string) => Promise<DeleteInstanceResultPayload>

  installFabric: (gameVersion: string, loaderVersion?: string) => Promise<{ versionId: string }>
  listMods: (instanceId: string) => Promise<ModFilePayload[]>
  removeMod: (instanceId: string, filename: string) => Promise<void>
  installModLocal: (instanceId: string, jarPath: string) => Promise<string>
  getOptions: (instanceId: string) => Promise<OptionEntry[]>
  setOptions: (instanceId: string, entries: Record<string, string>) => Promise<OptionEntry[]>

  getAiConfig: () => Promise<AiConfigPayload>
  setAiConfig: (ai: { baseUrl: string; apiKey: string; model: string }) => Promise<AiConfigPayload>
  aiSend: (text: string) => Promise<{ content: string }>
  aiClear: () => Promise<void>
  aiHistory: () => Promise<Array<{ role: 'user' | 'assistant'; text: string }>>

  listPanels: () => Promise<PanelStatePayload[]>
  panelAction: (panelId: string, action: string) => Promise<void>

  extPending: () => Promise<PendingExtensionPayload | null>
  extApprove: () => Promise<SubmitResultPayload>
  extReject: () => Promise<SubmitResultPayload>
  extList: () => Promise<ExtensionSummaryPayload[]>
  extRemove: (id: string) => Promise<SubmitResultPayload>

  splashRetry: () => Promise<void>
  splashContinue: () => Promise<void>

  onSplashProgress: (callback: (payload: SplashProgressPayload) => void) => Unsubscribe
  onNotify: (callback: (payload: NotifyPayload) => void) => Unsubscribe
  onInstallProgress: (callback: (payload: InstallProgressPayload) => void) => Unsubscribe
  onInstallDone: (callback: (payload: InstallDonePayload) => void) => Unsubscribe
  onJavaInstallProgress: (callback: (payload: JavaInstallProgressPayload) => void) => Unsubscribe
  onAccountChanged: (callback: (payload: AccountPayload | null) => void) => Unsubscribe
  onGameLog: (callback: (payload: GameLogPayload) => void) => Unsubscribe
  onGameExit: (callback: (payload: GameExitPayload) => void) => Unsubscribe
  onAiDelta: (callback: (payload: AiDeltaPayload) => void) => Unsubscribe
  onAiTool: (callback: (payload: AiToolEventPayload) => void) => Unsubscribe
  onAiDone: (callback: (payload: AiDonePayload) => void) => Unsubscribe
  onAiError: (callback: (payload: AiErrorPayload) => void) => Unsubscribe
  onPanelChanged: (callback: (payload: PanelStatePayload[]) => void) => Unsubscribe
  onExtPending: (callback: (payload: PendingExtensionPayload | null) => void) => Unsubscribe
  onExtListChanged: (callback: (payload: ExtensionSummaryPayload[]) => void) => Unsubscribe
}

interface Window {
  mcl: MclApi
}
