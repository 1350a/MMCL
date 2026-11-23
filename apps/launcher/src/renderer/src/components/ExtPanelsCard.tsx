import type { Run } from '../hooks/useRunner'

/** 扩展面板卡（M5-4）：扩展声明的声明式 UI。 */
export function ExtPanelsCard({ panels, run }: { panels: PanelStatePayload[]; run: Run }) {
  return (
    <section className="card">
      <h2>扩展面板</h2>
      {panels.map((panel) => (
        <div key={panel.id} className="ext-panel">
          <h3>{panel.title}</h3>
          {panel.items.map((item, i) => {
            if (item.type === 'text') {
              return (
                <p key={i} className="ext-text">
                  {item.content}
                </p>
              )
            }
            if (item.type === 'kv') {
              return (
                <div key={i} className="ext-kv">
                  {Object.entries(item.rows ?? {}).map(([k, v]) => (
                    <div key={k} className="ext-kv-row">
                      <span>{k}</span>
                      <b>{v}</b>
                    </div>
                  ))}
                </div>
              )
            }
            if (item.type === 'button') {
              return (
                <button
                  key={i}
                  className="ext-btn"
                  onClick={() =>
                    run(async () => {
                      await window.mcl.panelAction(panel.id, item.action ?? '')
                    })
                  }
                >
                  {item.label}
                </button>
              )
            }
            return null
          })}
        </div>
      ))}
    </section>
  )
}
