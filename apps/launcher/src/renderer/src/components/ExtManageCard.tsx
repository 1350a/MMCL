import type { useExtensions } from '../hooks/useExtensions'

/** 扩展管理卡（M5-5/6）：已装载扩展列表与移除。 */
export function ExtManageCard({ vm }: { vm: ReturnType<typeof useExtensions> }) {
  return (
    <section className="card">
      <h2>扩展管理</h2>
      {vm.extensions.length ? (
        vm.extensions.map((e) => (
          <div key={e.id} className="ext-row">
            <div className="row">
              <span style={{ flex: 1 }}>
                <b>{e.id}</b> · {e.name}
                {e.version ? ` · v${e.version}` : ''}（{e.state === 'active' ? '运行中' : '已停用'}）
              </span>
              <button onClick={() => vm.onRemoveExt(e.id)}>移除</button>
            </div>
            <div className="ext-chips">
              {e.capabilities.map((c) => (
                <span key={c} className={`chip${c === 'fs.instance' || c === 'net.domains' ? ' chip-warn' : ''}`}>
                  {c}
                </span>
              ))}
            </div>
            {(e.fsInstances?.length || e.netDomains?.length) && (
              <div className="result">
                {e.fsInstances?.length ? `fs：${e.fsInstances.join('、')}　` : ''}
                {e.netDomains?.length ? `net：${e.netDomains.join('、')}` : ''}
              </div>
            )}
          </div>
        ))
      ) : (
        <div className="result">（无扩展——对 AI 说「帮我写一个扩展」来生成，批准后在这里管理）</div>
      )}
    </section>
  )
}
