/** 扩展审核卡（M5-5）：AI 提案的清单摘要、能力标签与代码预览。 */
export function ExtReviewCard({
  pending,
  onApprove,
  onReject
}: {
  pending: PendingExtensionPayload
  onApprove: () => void
  onReject: () => void
}) {
  return (
    <section className="card">
      <h2>扩展审核（AI 提案）</h2>
      <div className="result">
        {pending.manifest.id} · {pending.manifest.name}
        {pending.manifest.version ? ` · v${pending.manifest.version}` : ''}
        {pending.manifest.requires?.length ? ` · 依赖：${pending.manifest.requires.join('、')}` : ''}
      </div>
      <div className="ext-chips">
        {pending.manifest.capabilities.map((c) => (
          <span key={c} className={`chip${c === 'fs.instance' || c === 'net.domains' ? ' chip-warn' : ''}`}>
            {c}
          </span>
        ))}
      </div>
      {(pending.manifest.fsInstances?.length || pending.manifest.netDomains?.length) && (
        <div className="result">
          {pending.manifest.fsInstances?.length ? `fs 作用域：${pending.manifest.fsInstances.join('、')}　` : ''}
          {pending.manifest.netDomains?.length ? `net 白名单：${pending.manifest.netDomains.join('、')}` : ''}
        </div>
      )}
      <div className="log ext-code">{pending.code}</div>
      <div className="row">
        <button onClick={onApprove}>批准并装载</button>
        <button onClick={onReject}>拒绝</button>
      </div>
    </section>
  )
}
