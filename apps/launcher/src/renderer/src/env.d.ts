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

interface AccountPayload {
  name: string
  uuid: string
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

interface MclApi {
  ping: () => Promise<string>
  sha1: (filePath: string) => Promise<string>

  getSettings: () => Promise<SettingsPayload>
  setJavaPath: (javaPath: string) => Promise<SettingsPayload>
  getAccount: () => Promise<AccountPayload | null>
  saveAccount: (name: string) => Promise<AccountPayload>

  listRemoteVersions: () => Promise<RemoteVersion[]>
  listInstalledVersions: () => Promise<string[]>
  installVersion: (id: string) => Promise<void>

  listRuntimes: () => Promise<RuntimeInfoPayload[]>
  installRuntime: (major: number) => Promise<RuntimeInfoPayload>

  launchGame: (id: string) => Promise<{ logFile: string }>
  stopGame: () => Promise<void>
  readGameLog: () => Promise<string>
  isGameRunning: () => Promise<boolean>

  getAiConfig: () => Promise<AiConfigPayload>
  setAiConfig: (ai: { baseUrl: string; apiKey: string; model: string }) => Promise<AiConfigPayload>
  aiSend: (text: string) => Promise<{ content: string }>
  aiClear: () => Promise<void>

  onInstallProgress: (callback: (payload: InstallProgressPayload) => void) => Unsubscribe
  onInstallDone: (callback: (payload: InstallDonePayload) => void) => Unsubscribe
  onJavaInstallProgress: (callback: (payload: JavaInstallProgressPayload) => void) => Unsubscribe
  onGameLog: (callback: (payload: GameLogPayload) => void) => Unsubscribe
  onGameExit: (callback: (payload: GameExitPayload) => void) => Unsubscribe
  onAiDelta: (callback: (payload: AiDeltaPayload) => void) => Unsubscribe
  onAiDone: (callback: (payload: AiDonePayload) => void) => Unsubscribe
  onAiError: (callback: (payload: AiErrorPayload) => void) => Unsubscribe
}

interface Window {
  mcl: MclApi
}
