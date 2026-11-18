import { contextBridge, ipcRenderer } from 'electron'

// 渲染进程唯一的能力入口：白名单 IPC。
// 后续（M1 起）逐步加入版本、账户、启动等能力，严禁直接暴露 Node API。
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  sha1: (filePath: string): Promise<string> => ipcRenderer.invoke('core:sha1', filePath)
}

contextBridge.exposeInMainWorld('mcl', api)
