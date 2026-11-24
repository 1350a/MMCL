import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// 渲染进程唯一的能力入口：白名单 IPC。
// 严禁直接暴露 Node API；新增 channel 时同步 env.d.ts 的 MclApi 类型。
const on = (channel: string) => (callback: (payload: unknown) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  sha1: (filePath: string): Promise<string> => ipcRenderer.invoke('core:sha1', filePath),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setJavaPath: (javaPath: string) => ipcRenderer.invoke('settings:setJavaPath', javaPath),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: {
    javaPath?: string
    isolationStrategy?: 'all' | 'none' | 'snapshotOnly' | 'modOnly' | 'snapshotAndMod'
    updates?: 'auto' | 'notify' | 'notifyImportant' | 'off'
    autoCleanupVersions?: boolean
    downloadSource?: 'official' | 'bmclapi'
    ui?: { sidebarHidden?: boolean; backgroundPath?: string; aiDisabled?: boolean }
  }) => ipcRenderer.invoke('config:set', patch),
  getAccount: () => ipcRenderer.invoke('account:get'),
  saveAccount: (name: string) => ipcRenderer.invoke('account:save', name),
  listAccounts: () => ipcRenderer.invoke('account:list'),
  switchAccount: (id: string) => ipcRenderer.invoke('account:switch', id),
  deleteAccount: (id: string) => ipcRenderer.invoke('account:delete', id),

  yggdrasilLogin: (server: string, username: string, password: string) =>
    ipcRenderer.invoke('auth:yggdrasil-login', server, username, password),
  selectProfile: (profileId: string) => ipcRenderer.invoke('auth:select-profile', profileId),
  logoutAccount: () => ipcRenderer.invoke('auth:logout'),
  fetchSkin: () => ipcRenderer.invoke('auth:skin'),

  listRemoteVersions: () => ipcRenderer.invoke('version:listRemote'),
  listInstalledVersions: () => ipcRenderer.invoke('version:listInstalled'),
  installVersion: (id: string) => ipcRenderer.invoke('version:install', id),
  cancelInstall: () => ipcRenderer.invoke('version:cancelInstall'),

  listRuntimes: () => ipcRenderer.invoke('java:listRuntimes'),
  installRuntime: (major: number) => ipcRenderer.invoke('java:installRuntime', major),
  cancelRuntimeInstall: () => ipcRenderer.invoke('java:cancelRuntimeInstall'),

  launchGame: (id: string) => ipcRenderer.invoke('game:launch', id),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  readGameLog: () => ipcRenderer.invoke('game:readLog'),
  isGameRunning: () => ipcRenderer.invoke('game:isRunning'),

  listInstances: () => ipcRenderer.invoke('instance:list'),
  createInstance: (input: { id?: string; name: string; versionId?: string }) =>
    ipcRenderer.invoke('instance:create', input),
  setInstanceVersion: (instanceId: string, versionId: string) =>
    ipcRenderer.invoke('instance:setVersion', instanceId, versionId),
  updateInstance: (instanceId: string, patch: { name?: string; isolation?: string }) =>
    ipcRenderer.invoke('instance:update', instanceId, patch),
  deleteInstance: (instanceId: string) => ipcRenderer.invoke('instance:delete', instanceId),

  installFabric: (gameVersion: string, loaderVersion?: string) =>
    ipcRenderer.invoke('fabric:install', gameVersion, loaderVersion),
  listMods: (instanceId: string) => ipcRenderer.invoke('mod:list', instanceId),
  removeMod: (instanceId: string, filename: string) => ipcRenderer.invoke('mod:remove', instanceId, filename),
  installModLocal: (instanceId: string, jarPath: string) =>
    ipcRenderer.invoke('mod:installLocal', instanceId, jarPath),
  getOptions: (instanceId: string) => ipcRenderer.invoke('config:getOptions', instanceId),
  setOptions: (instanceId: string, entries: Record<string, string>) =>
    ipcRenderer.invoke('config:setOptions', instanceId, entries),

  getAiConfig: () => ipcRenderer.invoke('ai:getConfig'),
  setAiConfig: (ai: { baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:setConfig', ai),
  aiSend: (text: string) => ipcRenderer.invoke('ai:send', text),
  aiClear: () => ipcRenderer.invoke('ai:clear'),
  aiHistory: () => ipcRenderer.invoke('ai:history'),

  listPanels: () => ipcRenderer.invoke('ext:listPanels'),
  panelAction: (panelId: string, action: string) => ipcRenderer.invoke('ext:panel-action', panelId, action),

  extEnable: (id: string) => ipcRenderer.invoke('ext:enable', id),
  extDisable: (id: string) => ipcRenderer.invoke('ext:disable', id),
  extList: () => ipcRenderer.invoke('ext:list'),
  extRemove: (id: string) => ipcRenderer.invoke('ext:remove', id),

  // UI 重构 C6：系统原生目录选择 + 游戏根切换（重启生效）
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-directory'),
  setGameRoot: (path: string) => ipcRenderer.invoke('gameRoot:set', path),

  // UI 重构 C7：设置页（自定义背景 data URL / 隔离策略变更预览 / 应用版本号）
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  getBackground: () => ipcRenderer.invoke('background:get'),
  previewIsolation: (strategy: string) => ipcRenderer.invoke('isolation:preview', strategy),
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  // UI 重构 C4：splash 管线（进度推送 + 错误面板交互）
  splashRetry: () => ipcRenderer.invoke('splash:retry'),
  splashContinue: () => ipcRenderer.invoke('splash:continue'),

  onSplashProgress: on('splash:progress'),
  onNotify: on('event:notify'),
  onInstallProgress: on('event:install-progress'),
  onInstallDone: on('event:install-done'),
  onJavaInstallProgress: on('event:java-install-progress'),
  onAccountChanged: on('event:account-changed'),
  onGameLog: on('event:game-log'),
  onGameExit: on('event:game-exit'),
  onAiDelta: on('event:ai-delta'),
  onAiTool: on('event:ai-tool'),
  onAiDone: on('event:ai-done'),
  onAiError: on('event:ai-error'),
  onPanelChanged: on('event:panel-changed'),
  onExtListChanged: on('event:ext-list-changed')
}

contextBridge.exposeInMainWorld('mcl', api)
