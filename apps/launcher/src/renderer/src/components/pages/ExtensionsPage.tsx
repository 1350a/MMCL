import type { useExtensions } from '../../hooks/useExtensions'
import type { Run } from '../../hooks/useRunner'
import { ExtManageCard } from '../ExtManageCard'
import { ExtPanelsCard } from '../ExtPanelsCard'

/** 插件页（C8）：扩展安装/启停 + 扩展面板。 */
export function ExtensionsPage({ ext, run }: { ext: ReturnType<typeof useExtensions>; run: Run }) {
  return (
    <div className="page">
      <ExtManageCard vm={ext} />
      <ExtPanelsCard panels={ext.panels} run={run} />
    </div>
  )
}
