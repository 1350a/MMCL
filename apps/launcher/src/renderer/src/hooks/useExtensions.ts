import { useEffect, useState } from 'react'
import type { Run } from './useRunner'

/** 扩展域：扩展面板（M5-4）、扩展安装与启停管理（C8）。 */
export function useExtensions(run: Run, setMessage: (m: string) => void) {
  // 扩展面板（M5-4）
  const [panels, setPanels] = useState<PanelStatePayload[]>([])
  // 扩展安装与启停（C8）
  const [extensions, setExtensions] = useState<ExtensionSummaryPayload[]>([])

  useEffect(() => {
    window.mcl.listPanels().then(setPanels)
    window.mcl.extList().then(setExtensions)
    const unsubs = [
      window.mcl.onPanelChanged((list) => setPanels(list)),
      window.mcl.onExtListChanged((list) => setExtensions(list))
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  const onEnableExt = (id: string) =>
    run(async () => {
      await window.mcl.extEnable(id)
      setMessage('')
    })

  const onDisableExt = (id: string) =>
    run(async () => {
      await window.mcl.extDisable(id)
      setMessage('')
    })

  const onRemoveExt = (id: string) =>
    run(async () => {
      await window.mcl.extRemove(id)
      setMessage('')
    })

  return { panels, extensions, onEnableExt, onDisableExt, onRemoveExt }
}
