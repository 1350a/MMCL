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
  getAccount: () => ipcRenderer.invoke('account:get'),
  saveAccount: (name: string) => ipcRenderer.invoke('account:save', name),

  listRemoteVersions: () => ipcRenderer.invoke('version:listRemote'),
  listInstalledVersions: () => ipcRenderer.invoke('version:listInstalled'),
  installVersion: (id: string) => ipcRenderer.invoke('version:install', id),

  listRuntimes: () => ipcRenderer.invoke('java:listRuntimes'),
  installRuntime: (major: number) => ipcRenderer.invoke('java:installRuntime', major),

  launchGame: (id: string) => ipcRenderer.invoke('game:launch', id),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  readGameLog: () => ipcRenderer.invoke('game:readLog'),
  isGameRunning: () => ipcRenderer.invoke('game:isRunning'),

  getAiConfig: () => ipcRenderer.invoke('ai:getConfig'),
  setAiConfig: (ai: { baseUrl: string; apiKey: string; model: string }) => ipcRenderer.invoke('ai:setConfig', ai),
  aiSend: (text: string) => ipcRenderer.invoke('ai:send', text),
  aiClear: () => ipcRenderer.invoke('ai:clear'),

  onInstallProgress: on('event:install-progress'),
  onInstallDone: on('event:install-done'),
  onJavaInstallProgress: on('event:java-install-progress'),
  onGameLog: on('event:game-log'),
  onGameExit: on('event:game-exit'),
  onAiDelta: on('event:ai-delta'),
  onAiDone: on('event:ai-done'),
  onAiError: on('event:ai-error')
}

contextBridge.exposeInMainWorld('mcl', api)
