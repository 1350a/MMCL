import { useEffect, useState } from 'react'
import type { Run } from './useRunner'

/** 扩展域：扩展面板（M5-4）、扩展审核与管理（M5-5/6）。 */
export function useExtensions(run: Run, setMessage: (m: string) => void) {
  // 扩展面板（M5-4）
  const [panels, setPanels] = useState<PanelStatePayload[]>([])
  // 扩展审核与管理（M5-5/6）
  const [pendingExt, setPendingExt] = useState<PendingExtensionPayload | null>(null)
  const [extensions, setExtensions] = useState<ExtensionSummaryPayload[]>([])

  useEffect(() => {
    window.mcl.listPanels().then(setPanels)
    window.mcl.extPending().then(setPendingExt)
    window.mcl.extList().then(setExtensions)
    const unsubs = [
      window.mcl.onPanelChanged((list) => setPanels(list)),
      window.mcl.onExtPending((p) => setPendingExt(p)),
      window.mcl.onExtListChanged((list) => setExtensions(list))
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  const onApproveExt = () =>
    run(async () => {
      await window.mcl.extApprove()
      setMessage('')
    })

  const onRejectExt = () =>
    run(async () => {
      await window.mcl.extReject()
      setMessage('')
    })

  const onRemoveExt = (id: string) =>
    run(async () => {
      await window.mcl.extRemove(id)
      setMessage('')
    })

  return { panels, pendingExt, extensions, onApproveExt, onRejectExt, onRemoveExt }
}
