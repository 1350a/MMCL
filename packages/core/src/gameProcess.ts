import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchSpec } from './launch'

export interface LaunchHandlers {
  /** 按行回调（stdout / stderr 合流，带来源标记）。 */
  onLog?: (line: string, source: 'stdout' | 'stderr') => void
  /** 进程退出（code 可能为 null，表示被信号终止）。 */
  onExit?: (code: number | null) => void
  /** 进程启动失败（如 java 不存在）。 */
  onError?: (err: Error) => void
}

export interface LaunchHandle {
  process: ChildProcess
  /** 日志文件路径（cwd/logs/latest.log）。 */
  logFile: string
}

/** 按行切分数据块，跨 chunk 缓冲。 */
function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.length > 0) onLine(line.replace(/\r$/, ''))
    }
  }
}

/**
 * 启动游戏进程：stdout/stderr 追加写入 cwd/logs/latest.log 并按行回调。
 * 不等待进程结束——通过 handlers.onExit 接收退出码。
 */
export function launchGame(spec: LaunchSpec, handlers: LaunchHandlers = {}): LaunchHandle {
  const logFile = join(spec.cwd, 'logs', 'latest.log')
  mkdirSync(join(spec.cwd, 'logs'), { recursive: true })
  const stream = createWriteStream(logFile, { flags: 'a' })
  stream.write(`=== MCL launch ${new Date().toISOString()} ===\n`)

  const args = [...spec.jvmArgs, spec.mainClass, ...spec.gameArgs]
  const child = spawn(spec.javaPath, args, { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })

  const emitLog = (source: 'stdout' | 'stderr') =>
    lineSplitter((line) => {
      stream.write(`${line}\n`)
      handlers.onLog?.(line, source)
    })
  child.stdout?.on('data', (chunk: Buffer) => emitLog('stdout')(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => emitLog('stderr')(chunk.toString('utf8')))

  // error 与 close 可能都触发（spawn 失败时只有 error），退出回调只报一次
  let exited = false
  const reportExit = (code: number | null) => {
    if (exited) return
    exited = true
    stream.end()
    handlers.onExit?.(code)
  }

  child.on('close', (code) => reportExit(code))
  child.on('error', (err) => {
    handlers.onError?.(err)
    reportExit(-1)
  })

  return { process: child, logFile }
}
