import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { promises as fs, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { fileSha1 } from '@mcl/core'
import type { IsolationStrategy } from '@mcl/core'
import {
  defaultConfig,
  ensureGameDirs,
  loadConfig,
  migrateLegacyData,
  officialGameRoot,
  resolveGameRoot,
  resolveMmclDir,
  resolveWorkspaceDir,
  saveConfig
} from '@mcl/core'
import { LauncherService } from './launcher'
import { createSplashWindow, SplashPipeline } from './bootstrap'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const isSmokeTest = process.argv.includes('--smoke-test')

// 逃生舱：部分机器 Chromium 沙箱初始化失败（启动即崩、无输出），本机排障可用 --no-sandbox
if (process.argv.includes('--no-sandbox')) {
  console.warn('[mcl] 警告：Chromium 沙箱已关闭（--no-sandbox），仅供本机排障，切勿用于发布构建')
}

/**
 * Splash 步骤 1-2 + 服务装配（UI-DESIGN.md §5 步骤 1-2 的数据层部分）：
 * .mmcl 目录就绪 → 配置读取（损坏自动重置）→ 游戏根解析（记忆 → 官启探测 → 兜底新建）→
 * 遗留 userData 数据幂等迁移（settings.json 并入 mmcl.json、账户/AI 会话/扩展进 .mmcl、
 * versions/libraries/assets/instances 进游戏根）→ LauncherService 装配。
 */
async function bootstrapLauncher(
  pipeline: SplashPipeline,
  send: (channel: string, payload: unknown) => void
): Promise<LauncherService> {
  const mmclDir = resolveMmclDir(os.homedir())
  const configPath = join(mmclDir, 'mmcl.json')

  // 步骤 1：配置读取（损坏 → 重置默认，core 内处理）
  let config = defaultConfig()
  await pipeline.runStep(1, async () => {
    config = await loadConfig(configPath)
  })

  // 步骤 2：工作区检查（游戏根解析 + 标准目录补建 + 遗留迁移 + workspace 创建）
  let dirs = { mmclDir, gameRoot: join(mmclDir, '.minecraft') }
  await pipeline.runStep(2, async () => {
    const resolution = resolveGameRoot({
      mmclDir,
      lastGameRoot: config.lastGameRoot,
      officialGameRoot: officialGameRoot(app.getPath('appData'))
    })
    if (resolution.warning) console.warn('[mcl]', resolution.warning)
    console.log(`[mcl] 游戏根：${resolution.root}（${resolution.source}）`)
    await ensureGameDirs(resolution.root)
    await fs.mkdir(resolveWorkspaceDir(mmclDir), { recursive: true })

    // 遗留数据迁移先于配置落盘：settings.json 的吸收要求按缺补入而非整文件覆盖
    // （幂等：源为空即零操作；失败条目保留原地并记日志）
    const migration = await migrateLegacyData({
      legacyRoot: app.getPath('userData'),
      mmclDir,
      gameRoot: resolution.root,
      configPath,
      config
    })
    config = migration.config
    const report = migration.report
    for (const f of report.failed) console.error('[mcl] 遗留数据迁移失败：', f.item, '→', f.error)
    if (report.moved.length > 0) {
      console.log('[mcl] 遗留数据迁移完成：', report.moved.join('、'))
    }

    if (config.lastGameRoot !== resolution.root) {
      config.lastGameRoot = resolution.root
      await saveConfig(configPath, config)
    }
    dirs = { mmclDir, gameRoot: resolution.root }
  })

  return new LauncherService(dirs, config, send)
}

/** 主窗口（titleBarStyle hidden + 系统渲染 caption 按钮，保留 Aero Snap/DPI/Win11 圆角）。 */
function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#eef0f6',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f2f4f8', // 浅色主题顶栏条（2026-11-23 验收定版）
      symbolColor: '#2a2f3a',
      height: 36
    },
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

  const ready = new Promise<void>((resolve) => {
    win.on('ready-to-show', () => {
      win.show()
      console.log('[mcl] window ready')
      resolve()
      if (isSmokeTest) {
        // 落盘标记：供无法捕获 stdout 的 CI/调度器场景验证窗口已就绪
        writeFileSync(join(process.cwd(), 'smoke-ok.txt'), 'LAUNCHER_SMOKE_OK\n')
        console.log('LAUNCHER_SMOKE_OK')
        app.quit()
      }
    })
  })

  if (isDev) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return ready
}

function registerIpc(service: LauncherService): void {
  ipcMain.handle('app:ping', () => 'pong (main process)')

  ipcMain.handle('core:sha1', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('invalid file path')
    }
    return fileSha1(filePath)
  })

  // M1：账户 / 设置 / 版本 / 启动（业务编排全部在 LauncherService）
  ipcMain.handle('settings:get', () => service.getSettings())
  ipcMain.handle('settings:setJavaPath', (_e, javaPath: string) => service.setJavaPath(javaPath))
  // UI 重构 C3：全局配置读写（白名单字段合并更新，mmcl.json）
  ipcMain.handle('config:get', () => service.getConfigPayload())
  ipcMain.handle('config:set', (_e, patch) => service.setConfig(patch))
  ipcMain.handle('account:get', () => service.getAccountPayload())
  ipcMain.handle('account:save', (_e, name: string) => service.saveAccount(name))
  // UI 重构 C5：多账户（列表/切换/删除）
  ipcMain.handle('account:list', () => service.listAccountsPayload())
  ipcMain.handle('account:switch', (_e, id: string) => service.switchAccount(id))
  ipcMain.handle('account:delete', (_e, id: string) => service.deleteAccount(id))
  // M3 外置登录（authlib-injector / Yggdrasil）
  ipcMain.handle('auth:yggdrasil-login', (_e, server: string, username: string, password: string) =>
    service.yggdrasilLogin(server, username, password)
  )
  ipcMain.handle('auth:select-profile', (_e, profileId: string) => service.selectYggdrasilProfile(profileId))
  ipcMain.handle('auth:logout', () => service.logoutAccount())
  ipcMain.handle('auth:skin', () => service.fetchCurrentSkin())
  ipcMain.handle('version:listRemote', () => service.listRemoteVersions())
  ipcMain.handle('version:listInstalled', () => service.listInstalledVersions())
  ipcMain.handle('version:install', (_e, id: string) => service.installVersion(id))
  ipcMain.handle('version:cancelInstall', () => service.cancelInstallVersion())
  ipcMain.handle('java:listRuntimes', () => service.listRuntimes())
  ipcMain.handle('java:installRuntime', (_e, major: number) => service.installRuntimeFor(major))
  ipcMain.handle('java:cancelRuntimeInstall', () => service.cancelRuntimeInstall())
  // M6 多实例：实例清单 / 新建 / 绑定版本；game:launch 改按实例启动
  ipcMain.handle('instance:list', () => service.listInstancesPayload())
  ipcMain.handle('instance:create', (_e, input: { id?: string; name: string; versionId?: string }) => {
    if (typeof input !== 'object' || input === null || typeof input.name !== 'string') {
      throw new Error('invalid instance create params')
    }
    return service.createInstancePayload(input)
  })
  ipcMain.handle('instance:setVersion', (_e, instanceId: string, versionId: string) => {
    if (typeof instanceId !== 'string' || typeof versionId !== 'string') throw new Error('invalid instance params')
    return service.setInstanceVersion(instanceId, versionId)
  })
  // UI 重构 C5：版本设置（重命名 / 每版本隔离策略）
  ipcMain.handle('instance:update', (_e, instanceId: string, patch: { name?: string; isolation?: string }) => {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    if (typeof patch !== 'object' || patch === null) throw new Error('invalid instance patch')
    return service.updateInstancePayload(instanceId, patch as { name?: string; isolation?: IsolationStrategy | 'follow' })
  })
  ipcMain.handle('instance:delete', (_e, instanceId: string) => {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    return service.deleteInstancePayload(instanceId)
  })
  ipcMain.handle('game:launch', (_e, instanceId: string) => service.launchInstance(instanceId))
  ipcMain.handle('ai:getConfig', () => service.getAiConfig())
  ipcMain.handle('ai:setConfig', (_e, ai) => service.setAiConfig(ai))
  ipcMain.handle('ai:send', (_e, text: string) => service.aiSend(text))
  ipcMain.handle('ai:clear', () => service.aiClear())
  ipcMain.handle('ai:history', () => service.aiHistoryPayload())
  // M5-4：扩展面板
  ipcMain.handle('ext:listPanels', () => service.listPanels())
  ipcMain.handle('ext:panel-action', (_e, panelId: string, action: string) => {
    if (typeof panelId !== 'string' || typeof action !== 'string') throw new Error('invalid panel action params')
    return service.panelAction(panelId, action)
  })
  // C8：扩展管理（生成即保存；默认不装载，启用/停用热切换）
  ipcMain.handle('ext:enable', (_e, id: string) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid extension id')
    return service.extEnable(id)
  })
  ipcMain.handle('ext:disable', (_e, id: string) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid extension id')
    return service.extDisable(id)
  })
  ipcMain.handle('ext:list', () => service.extList())
  ipcMain.handle('ext:remove', (_e, id: string) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('invalid extension id')
    return service.extRemove(id)
  })
  ipcMain.handle('game:stop', () => service.stopGame())
  ipcMain.handle('game:readLog', () => service.readGameLog())
  ipcMain.handle('game:isRunning', () => service.isGameRunning())
  // M4：Fabric 加载器 / mod 管理 / options.txt
  ipcMain.handle('fabric:install', (_e, gameVersion: string, loaderVersion?: string) =>
    service.installFabricVersion(gameVersion, loaderVersion)
  )
  ipcMain.handle('mod:list', (_e, instanceId: string) => {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    return service.listModsPayload(instanceId)
  })
  ipcMain.handle('mod:remove', (_e, instanceId: string, filename: string) => {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    return service.removeModFile(instanceId, filename)
  })
  ipcMain.handle('mod:installLocal', (_e, instanceId: string, jarPath: string) => {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    return service.installModFromLocal(instanceId, jarPath)
  })
  ipcMain.handle('config:getOptions', (_e, instanceId: string) => {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    return service.readGameOptions(instanceId)
  })
  ipcMain.handle('config:setOptions', (_e, instanceId: string, entries: Record<string, string>) => {
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new Error('invalid instance id')
    return service.writeGameOptions(instanceId, entries)
  })

  // UI 重构 C6：系统原生目录选择（游戏根；C7 自定义背景另走文件选择）+ 游戏根切换（重启生效）
  ipcMain.handle('dialog:pick-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择游戏根目录（.minecraft）',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('gameRoot:set', (_e, path: string) => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('invalid game root path')
    return service.setGameRoot(path, app.getPath('userData'))
  })

  // UI 重构 C7：设置页——自定义背景（系统文件对话框 + 固定目录 data URL）/ 隔离策略预览 / 版本号
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('dialog:pick-image', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return service.setBackgroundImage(result.filePaths[0])
  })
  ipcMain.handle('background:get', () => service.readBackground())
  ipcMain.handle('isolation:preview', (_e, strategy: string) =>
    service.previewGlobalIsolationChange(strategy as IsolationStrategy)
  )
}

app.whenReady()
  .then(async () => {
    const broadcastSend = (channel: string, payload: unknown): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload)
      }
    }
    // 冒烟无头：不建 splash 窗、错误自动跳过
    const splash = isSmokeTest ? null : createSplashWindow()
    const pipeline = new SplashPipeline({
      send: (p) => splash?.webContents.send('splash:progress', p),
      interactive: !isSmokeTest
    })

    const service = await bootstrapLauncher(pipeline, broadcastSend)
    registerIpc(service)

    // 步骤 3：版本初始化（默认实例迁移 + 扫描已装 + 校正 lastVersionId；失败可重试/跳过）
    await pipeline.runStep(3, async () => {
      await service.ensureInstancesReady()
      const installed = await service.listInstalledVersions()
      const configPath = join(service.dirs.mmclDir, 'mmcl.json')
      const current = await loadConfig(configPath)
      if (current.lastVersionId && !installed.includes(current.lastVersionId)) {
        delete current.lastVersionId
        await saveConfig(configPath, current)
      }
    })

    // 步骤 4：扩展注册（构造器已后台启动；完成经组件宿主事件通知——C5 接通知 UI）
    pipeline.markBackground(4, '后台进行中，完成后通知')

    // 步骤 5：更新检查（服务器未实装，管线留位）
    await pipeline.runStep(5, async () => {
      // 更新服务器未实装（UI-DESIGN.md §9），设置项已落地、逻辑留位
    })

    // 步骤 6：UI 预热（主窗口创建 + ready-to-show 显示）
    const ready = createWindow()
    await pipeline.runStep(6, async () => {
      await ready
    })

    // 主窗已显示：splash 淡出后销毁
    setTimeout(() => {
      splash?.destroy()
    }, 350)

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
  .catch((err) => {
    // 引导失败（目录不可写等）：无窗挂死不如显式失败退出
    console.error('[mcl] 启动引导失败：', err)
    app.exit(1)
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
