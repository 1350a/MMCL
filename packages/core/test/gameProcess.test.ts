import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchGame } from '../src'
import type { LaunchSpec } from '../src'

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

/** 用 node 脚本假扮 java：输出一行 stdout、一行 stderr，退出码 42。 */
async function makeFakeJavaScript(dir: string): Promise<string> {
  const script = join(dir, 'fake-java.js')
  await fs.writeFile(
    script,
    `console.log('game stdout line'); console.error('game stderr line'); process.exit(42)\n`
  )
  return script
}

describe('launchGame', () => {
  it('stdout/stderr 按行落盘 latest.log 并回调，退出码上报', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-game-'))
    tempDirs.push(dir)
    const script = await makeFakeJavaScript(dir)
    const spec: LaunchSpec = {
      javaPath: process.execPath,
      jvmArgs: [script],
      mainClass: '',
      gameArgs: [],
      cwd: dir
    }

    const logs: Array<{ line: string; source: string }> = []
    const exitCode = await new Promise<number | null>((resolve) => {
      launchGame(spec, {
        onLog: (line, source) => logs.push({ line, source }),
        onExit: (code) => resolve(code)
      })
    })

    expect(exitCode).toBe(42)
    expect(logs).toContainEqual({ line: 'game stdout line', source: 'stdout' })
    expect(logs).toContainEqual({ line: 'game stderr line', source: 'stderr' })

    const logContent = await fs.readFile(join(dir, 'logs', 'latest.log'), 'utf8')
    expect(logContent).toContain('=== MCL launch')
    expect(logContent).toContain('game stdout line')
    expect(logContent).toContain('game stderr line')
  })

  it('java 不存在时 onError + onExit(-1)', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mcl-game-'))
    tempDirs.push(dir)
    const spec: LaunchSpec = {
      javaPath: join(dir, 'no-such-java.exe'),
      jvmArgs: [],
      mainClass: 'C',
      gameArgs: [],
      cwd: dir
    }

    // 等两个事件都到达再断言
    const events: Array<'error' | 'exit'> = []
    await new Promise<void>((resolve) => {
      launchGame(spec, {
        onError: () => {
          events.push('error')
          if (events.length === 2) resolve()
        },
        onExit: (code) => {
          events.push('exit')
          expect(code).toBe(-1)
          if (events.length === 2) resolve()
        }
      })
    })
    expect(events).toContain('error')
    expect(events).toContain('exit')
  })
})
