import type { useGame } from '../hooks/useGame'
import type { useInstances } from '../hooks/useInstances'
import type { useJava } from '../hooks/useJava'
import type { useVersions } from '../hooks/useVersions'

/** 游戏实例卡（M6）：实例选择/启动/绑定/创建/删除 + 游戏日志 + Java 引导。 */
export function InstancesCard({
  vm,
  game,
  versions,
  java,
  needJavaMajor,
  account,
  onLaunch,
  onBindVersion
}: {
  vm: ReturnType<typeof useInstances>
  game: ReturnType<typeof useGame>
  versions: ReturnType<typeof useVersions>
  java: ReturnType<typeof useJava>
  needJavaMajor: number | null
  account: AccountPayload | null
  onLaunch: () => void
  onBindVersion: () => void
}) {
  return (
    <section className="card">
      <h2>游戏实例（M6 · 多实例隔离）</h2>
      <div className="row">
        <select value={vm.selectedInstance} onChange={(e) => vm.setSelectedInstance(e.target.value)}>
          <option value="">{vm.instances.length ? '选择实例…' : '实例加载中…'}</option>
          {vm.instances.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.name}（{inst.id}
              {inst.versionId ? ` · ${inst.versionId}` : ' · 未绑定版本'}）
            </option>
          ))}
        </select>
        <button
          onClick={onLaunch}
          disabled={!vm.selectedInstance || game.gameRunning || !account || !vm.selectedMeta?.versionId}
          title={!vm.selectedMeta?.versionId ? '该实例尚未绑定版本' : `启动实例绑定的 ${vm.selectedMeta?.versionId}`}
        >
          启动
        </button>
        <button onClick={() => window.mcl.stopGame()} disabled={!game.gameRunning}>
          停止
        </button>
        <button
          onClick={vm.onDeleteInstance}
          disabled={!vm.selectedInstance || game.gameRunning}
          title="删除选中实例（mods/存档/设置不可恢复，会先弹确认）"
        >
          删除
        </button>
      </div>
      <div className="row">
        <select value={versions.selectedInstalled} onChange={(e) => versions.setSelectedInstalled(e.target.value)}>
          <option value="">
            {vm.selectedMeta?.versionId ? `${vm.selectedMeta.versionId}（当前绑定）` : '为实例绑定已安装版本…'}
          </option>
          {versions.installed.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button onClick={onBindVersion} disabled={!vm.selectedInstance || !versions.selectedInstalled}>
          保存绑定
        </button>
        <button
          onClick={versions.onInstallFabric}
          disabled={!versions.selectedInstalled || versions.installing || versions.selectedInstalled.startsWith('fabric-loader-')}
          title={
            versions.selectedInstalled.startsWith('fabric-loader-')
              ? '该版本已是 Fabric 版本'
              : '为选中的原版版本安装最新稳定版 Fabric 加载器'
          }
        >
          装 Fabric
        </button>
      </div>
      <div className="result">
        每个实例有独立的 mods/存档/设置；版本与资源库全局共享，不随实例复制。
      </div>
      <div className="log" ref={game.logRef}>
        {game.gameLines.length === 0 ? '游戏日志将显示在这里…' : game.gameLines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
      {needJavaMajor !== null && (
        <div className="java-need">
          <span>启动该版本需要 Java {needJavaMajor}（内置运行时约 45MB，不写入系统环境变量）</span>
          <button onClick={java.onInstallRuntime} disabled={!!java.javaDl}>
            {java.javaDl
              ? `${java.javaDl.phase === 'download' ? '下载' : '解压'} ${java.javaDl.completed}/${java.javaDl.total}`
              : `下载 Java ${needJavaMajor}`}
          </button>
          {java.javaDl && <button onClick={java.onCancelRuntime}>取消</button>}
        </div>
      )}
      <div className="row">
        <input
          value={vm.newInstName}
          onChange={(e) => vm.setNewInstName(e.target.value)}
          placeholder="新实例名（如 1.16.5 服务器整合）"
        />
        <select value={vm.newInstVersion} onChange={(e) => vm.setNewInstVersion(e.target.value)}>
          <option value="">版本（可不选，稍后绑定）</option>
          {versions.installed.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button onClick={vm.onCreateInstance} disabled={!vm.newInstName.trim()}>
          创建实例
        </button>
      </div>
    </section>
  )
}
