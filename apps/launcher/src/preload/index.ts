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

  launchGame: (id: string) => ipcRenderer.invoke('game:launch', id),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  readGameLog: () => ipcRenderer.invoke('game:readLog'),
  isGameRunning: () => ipcRenderer.invoke('game:isRunning'),

  onInstallProgress: on('event:install-progress'),
  onInstallDone: on('event:install-done'),
  onGameLog: on('event:game-log'),
  onGameExit: on('event:game-exit')
}

contextBridge.exposeInMainWorld('mcl', api)
