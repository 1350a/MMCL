import { useEffect, useState } from 'react'
import type { Run } from './useRunner'
import type { ToastItem } from './useTasks'

/** 游戏根域（C6）：当前根展示 + 系统目录选择切换（不做热切换，重启启动器后生效）。 */
export function useGameRoot(run: Run, pushToast: (toast: Omit<ToastItem, 'id'> & { id?: string }) => void) {
  const [gameRoot, setGameRoot] = useState('')

  useEffect(() => {
    window.mcl.getConfig().then((c) => setGameRoot(c.lastGameRoot ?? ''))
  }, [])

  const onPickGameRoot = () =>
    run(async () => {
      const picked = await window.mcl.pickDirectory()
      if (!picked) return // 用户取消
      const result = await window.mcl.setGameRoot(picked)
      setGameRoot(result.gameRoot)
      pushToast({ kind: 'info', title: '游戏根已更新', body: `重启启动器后生效：${result.gameRoot}` })
    })

  return { gameRoot, onPickGameRoot }
}
