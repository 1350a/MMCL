import { useState } from 'react'

export type Run = (action: () => Promise<void>) => Promise<void>

/** 全局错误横幅 + run 包装（IPC 错误串解析）+ 启动所需 Java 版本提示。 */
export function useRunner() {
  const [message, setMessage] = useState('')
  const [needJavaMajor, setNeedJavaMajor] = useState<number | null>(null)

  async function run(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      const raw = (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      const need = /需要 Java (\d+)/.exec(raw)
      if (need) setNeedJavaMajor(Number(need[1]))
      setMessage(raw)
    }
  }

  return { message, setMessage, run, needJavaMajor, setNeedJavaMajor }
}
