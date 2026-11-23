import type { useMods } from '../hooks/useMods'

/** Mods 卡（M4）：当前实例的 mod 列表与本地安装。 */
export function ModsCard({ vm }: { vm: ReturnType<typeof useMods> }) {
  return (
    <section className="card">
      <h2>Mods（instances/{vm.selectedInstance || '…'}/mods）</h2>
      <div className="row">
        <input
          value={vm.modJarInput}
          onChange={(e) => vm.setModJarInput(e.target.value)}
          placeholder="本地 mod jar 路径（也可让 AI 从 Modrinth 安装）"
        />
        <button onClick={vm.onInstallLocalMod} disabled={!vm.modJarInput.trim()}>
          安装本地 mod
        </button>
      </div>
      <div className="result">
        {vm.mods.length
          ? vm.mods.map((m) => (
              <div key={m.filename} className="row">
                <span style={{ flex: 1 }}>
                  {m.filename}（{(m.sizeBytes / 1024).toFixed(0)} KB）
                </span>
                <button onClick={() => vm.onRemoveMod(m.filename)}>删除</button>
              </div>
            ))
          : '（mods 目录为空——可以在 AI 助手里说「帮我装 XX mod」）'}
      </div>
    </section>
  )
}
