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

// 游戏实例（M6 多实例）
interface InstanceMetaPayload {
  id: string
  name: string
  versionId?: string
  createdAt?: string
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

interface MclApi {
  ping: () => Promise<string>
  sha1: (filePath: string) => Promise<string>

  getSettings: () => Promise<SettingsPayload>
  setJavaPath: (javaPath: string) => Promise<SettingsPayload>
  getAccount: () => Promise<AccountPayload | null>
  saveAccount: (name: string) => Promise<OfflineAccountPayload>

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
  deleteInstance: (instanceId: string) => Promise<void>

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
