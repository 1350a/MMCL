import type { useJava } from '../hooks/useJava'

/** Java 运行时卡：本机路径设置与内置运行时列表。 */
export function JavaCard({ vm }: { vm: ReturnType<typeof useJava> }) {
  return (
    <section className="card">
      <h2>Java 运行时（本机路径）</h2>
      <div className="row">
        <input
          value={vm.javaInput}
          onChange={(e) => vm.setJavaInput(e.target.value)}
          placeholder="java.exe 路径或留空自动探测 PATH"
        />
        <button onClick={vm.onSaveJava}>保存并探测</button>
      </div>
      {vm.javaInfo && <div className="result">{vm.javaInfo}</div>}
      <div className="result">
        内置运行时:{vm.runtimes.length ? vm.runtimes.map((r) => `Java ${r.major}`).join('、') : '（无，启动高版本时按引导下载）'}
      </div>
    </section>
  )
}
