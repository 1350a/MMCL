import { useEffect, useState } from 'react'
import type { Run } from './useRunner'

/** mods 域（M4）：当前实例的 mod 列表与本地安装。 */
export function useMods(run: Run, setMessage: (m: string) => void, selectedInstance: string) {
  const [mods, setMods] = useState<ModFilePayload[]>([])
  const [modJarInput, setModJarInput] = useState('')

  const refreshMods = (): void => {
    if (!selectedInstance) return // 实例清单未就绪，随 selectedInstance 变化的 effect 会再刷
    window.mcl.listMods(selectedInstance).then(setMods)
  }

  // 切换实例：刷新该实例的 mods 列表
  useEffect(() => {
    refreshMods()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInstance])

  const onRemoveMod = (filename: string) =>
    run(async () => {
      await window.mcl.removeMod(selectedInstance, filename)
      refreshMods()
      setMessage('')
    })

  const onInstallLocalMod = () =>
    run(async () => {
      if (!modJarInput.trim() || !selectedInstance) return
      await window.mcl.installModLocal(selectedInstance, modJarInput.trim())
      setModJarInput('')
      refreshMods()
      setMessage('')
    })

  return { selectedInstance, mods, modJarInput, setModJarInput, refreshMods, onRemoveMod, onInstallLocalMod }
}
