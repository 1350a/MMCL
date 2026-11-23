import type { useVersions } from '../hooks/useVersions'

/** 版本安装卡：远端版本选择、安装进度与已装列表。 */
export function VersionsCard({ vm }: { vm: ReturnType<typeof useVersions> }) {
  return (
    <section className="card">
      <h2>版本安装</h2>
      <div className="row">
        <select
          value={vm.selectedRemote}
          onChange={(e) => vm.setSelectedRemote(e.target.value)}
          disabled={vm.remoteVersions.length === 0}
        >
          <option value="">{vm.remoteVersions.length ? '选择版本…' : '清单加载中…'}</option>
          {vm.releases.map((v) => (
            <option key={v.id} value={v.id}>
              {v.id}
            </option>
          ))}
        </select>
        <button onClick={vm.onInstall} disabled={!vm.selectedRemote || vm.installing}>
          安装
        </button>
        {vm.installing && (
          <button onClick={vm.onCancelInstall}>取消</button>
        )}
      </div>
      {vm.progress && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${vm.progress.total ? (vm.progress.completed / vm.progress.total) * 100 : 5}%` }} />
          <span className="progress-text">
            {vm.progress.completed}/{vm.progress.total} {vm.progress.file}
          </span>
        </div>
      )}
      {vm.installError && <div className="error">安装失败：{vm.installError}</div>}
      <div className="result">已安装：{vm.installed.length ? vm.installed.join('、') : '（无）'}</div>
    </section>
  )
}
