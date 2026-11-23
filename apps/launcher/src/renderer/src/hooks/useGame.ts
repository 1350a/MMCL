import { useEffect, useRef, useState } from 'react'

/** 游戏域：运行状态与日志缓冲。 */
export function useGame() {
  const [gameRunning, setGameRunning] = useState(false)
  const [gameLines, setGameLines] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.mcl.isGameRunning().then(setGameRunning)
    const unsubs = [
      window.mcl.onGameLog(({ line, source }) => {
        setGameLines((lines) => [...lines.slice(-2000), `[${source}] ${line}`])
      }),
      window.mcl.onGameExit(({ code }) => {
        setGameRunning(false)
        setGameLines((lines) => [...lines, `--- 游戏退出，退出码 ${code} ---`])
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [gameLines])

  return { gameRunning, setGameRunning, gameLines, setGameLines, logRef }
}
