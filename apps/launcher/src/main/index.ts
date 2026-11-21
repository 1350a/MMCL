import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileSha1 } from '@mcl/core'
import { LauncherService } from './launcher'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const isSmokeTest = process.argv.includes('--smoke-test')

// 逃生舱：部分机器 Chromium 沙箱初始化失败（启动即崩、无输出），本机排障可用 --no-sandbox
if (process.argv.includes('--no-sandbox')) {
  console.warn('[mcl] 警告：Chromium 沙箱已关闭（--no-sandbox），仅供本机排障，切勿用于发布构建')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 阻止渲染进程随意开新窗口，一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('did-finish-load', () => {
    console.log('[mcl] renderer loaded')
  })

  win.on('ready-to-show', () => {
    win.show()
    console.log('[mcl] window ready')
    if (isSmokeTest) {
      // 落盘标记：供无法捕获 stdout 的 CI/调度器场景验证窗口已就绪
      writeFileSync(join(process.cwd(), 'smoke-ok.txt'), 'LAUNCHER_SMOKE_OK\n')
      console.log('LAUNCHER_SMOKE_OK')
      app.quit()
    }
  })

  if (isDev) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('app:ping', () => 'pong (main process)')

  ipcMain.handle('core:sha1', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('invalid file path')
    }
    return fileSha1(filePath)
  })

  // M1：账户 / 设置 / 版本 / 启动（业务编排全部在 LauncherService）
  const service = new LauncherService(app.getPath('userData'), (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  })

  ipcMain.handle('settings:get', () => service.getSettings())
  ipcMain.handle('settings:setJavaPath', (_e, javaPath: string) => service.setJavaPath(javaPath))
  ipcMain.handle('account:get', () => service.getAccount())
  ipcMain.handle('account:save', (_e, name: string) => service.saveAccount(name))
  ipcMain.handle('version:listRemote', () => service.listRemoteVersions())
  ipcMain.handle('version:listInstalled', () => service.listInstalledVersions())
  ipcMain.handle('version:install', (_e, id: string) => service.installVersion(id))
  ipcMain.handle('java:listRuntimes', () => service.listRuntimes())
  ipcMain.handle('java:installRuntime', (_e, major: number) => service.installRuntimeFor(major))
  ipcMain.handle('game:launch', (_e, id: string) => service.launchVersion(id))
  ipcMain.handle('game:stop', () => service.stopGame())
  ipcMain.handle('game:readLog', () => service.readGameLog())
  ipcMain.handle('game:isRunning', () => service.isGameRunning())
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 冒烟自检兜底：30 秒内未完成直接失败退出，避免挂死
  if (isSmokeTest) {
    setTimeout(() => {
      console.error('SMOKE_TIMEOUT')
      app.exit(1)
    }, 30_000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
