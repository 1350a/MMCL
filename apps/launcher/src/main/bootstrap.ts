import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

/**
 * Splash 六步管线（UI-DESIGN.md §5）：
 * 1 配置读取 2 工作区检查 3 版本初始化（可重试/跳过）4 扩展注册（后台）
 * 5 更新检查（留位）6 UI 预热。单步 15s 超时按失败处理。
 * 步骤 1-2 的数据层逻辑在 index.ts bootstrapLauncher，这里只提供
 * 进度推送 / 超时 / 错误面板交互原语，由编排方逐步调用。
 */

export interface SplashProgress {
  step: number
  total: number
  label: string
  detail?: string
  state: 'running' | 'done' | 'error' | 'background' | 'skipped'
}

/** 单步超时（约 15s，§5）；migrate 超时后仍在后台继续，幂等保证可重试。 */
const STEP_TIMEOUT_MS = 15_000

export const SPLASH_TOTAL_STEPS = 6

/** 步骤名（进度条展示；与 UI-DESIGN.md §5 表一致）。 */
export const SPLASH_STEP_LABELS = ['配置读取', '工作区检查', '版本初始化', '扩展注册', '更新检查', 'UI 预热'] as const

export type SplashChoice = 'retry' | 'continue'

/** Splash 六步管线的进度/交互原语。 */
export class SplashPipeline {
  private readonly send: (progress: SplashProgress) => void
  /** 冒烟等无头场景：错误自动跳过，不挂等面板交互。 */
  private readonly interactive: boolean
  private choiceResolve: ((choice: SplashChoice) => void) | null = null

  constructor(options: { send: (progress: SplashProgress) => void; interactive: boolean }) {
    this.send = options.send
    this.interactive = options.interactive
    ipcMain.handle('splash:retry', () => {
      this.resolveChoice('retry')
    })
    ipcMain.handle('splash:continue', () => {
      this.resolveChoice('continue')
    })
  }

  private resolveChoice(choice: SplashChoice): void {
    this.choiceResolve?.(choice)
    this.choiceResolve = null
  }

  private waitChoice(): Promise<SplashChoice> {
    if (!this.interactive) return Promise.resolve('continue')
    return new Promise((resolve) => {
      this.choiceResolve = resolve
    })
  }

  /**
   * 执行一个阻塞步骤：推送 running → 成功推 done（返回 true）；
   * 失败/超时推 error 并等用户选择——retry 重跑该步，continue 跳过（推 skipped，返回 false）。
   */
  async runStep(step: number, action: () => Promise<void>): Promise<boolean> {
    const label = SPLASH_STEP_LABELS[step - 1] ?? `步骤 ${step}`
    for (;;) {
      this.send({ step, total: SPLASH_TOTAL_STEPS, label, state: 'running' })
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          action(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`步骤超时（${STEP_TIMEOUT_MS / 1000}s）`)), STEP_TIMEOUT_MS)
          })
        ])
        this.send({ step, total: SPLASH_TOTAL_STEPS, label, state: 'done' })
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.send({ step, total: SPLASH_TOTAL_STEPS, label, state: 'error', detail: message })
        const choice = await this.waitChoice()
        if (choice === 'continue') {
          this.send({ step, total: SPLASH_TOTAL_STEPS, label, state: 'skipped', detail: message })
          return false
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }

  /** 非阻塞步骤（如扩展注册）：标记后台进行中即返回。 */
  markBackground(step: number, detail?: string): void {
    this.send({
      step,
      total: SPLASH_TOTAL_STEPS,
      label: SPLASH_STEP_LABELS[step - 1] ?? `步骤 ${step}`,
      state: 'background',
      ...(detail ? { detail } : {})
    })
  }
}

const isDev = !!process.env['ELECTRON_RENDERER_URL']

/** 无边框 splash 小窗（~420×280，居中；背景与主页同基调）。 */
export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 280,
    center: true,
    frame: false,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#eef0f6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  splash.once('ready-to-show', () => splash.show())
  if (isDev) {
    void splash.loadURL(`${process.env['ELECTRON_RENDERER_URL']!}/splash.html`)
  } else {
    void splash.loadFile(join(__dirname, '../renderer/splash.html'))
  }
  return splash
}
