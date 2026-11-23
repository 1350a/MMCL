import type { useVersions } from '../../hooks/useVersions'
import type { useMods } from '../../hooks/useMods'
import type { useJava } from '../../hooks/useJava'
import type { useInstances } from '../../hooks/useInstances'
import type { useGameRoot } from '../../hooks/useGameRoot'

/** 常用 LTS 运行时快速下载项（MC 生态主流：1.16- 多为 8，1.17~1.20.4 为 17，1.20.5+ 为 21）。 */
const LTS_MAJORS = [8, 17, 21]

/**
 * 下载页（UI-DESIGN.md §2/§4/§7）：版本安装 / Mods 管理 / Java 运行时 / 游戏根。
 * 反馈分工：安装过程与结果走任务列表 + 通知（§6），页面只保留内联进度与错误行。
 */
export function DownloadPage({
  versions,
  mods,
  java,
  instances,
  gameRoot
}: {
  versions: ReturnType<typeof useVersions>
  mods: ReturnType<typeof useMods>
  java: ReturnType<typeof useJava>
  instances: ReturnType<typeof useInstances>
  gameRoot: ReturnType<typeof useGameRoot>
}) {
  const installedMajors = new Set(java.runtimes.map((r) => r.major))

  return (
    <div className="page">
      <section className="card">
        <h2>版本安装</h2>
        <div className="row">
          <select
            value={versions.selectedRemote}
            onChange={(e) => versions.setSelectedRemote(e.target.value)}
            disabled={versions.remoteVersions.length === 0 || versions.installing}
          >
            <option value="">{versions.remoteVersions.length ? '选择版本…' : '清单加载中…'}</option>
            {versions.releases.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
          <button onClick={versions.onInstall} disabled={!versions.selectedRemote || versions.installing}>
            安装
          </button>
          {versions.installing && <button onClick={versions.onCancelInstall}>取消</button>}
        </div>
        {versions.progress && (
          <div className="progress">
            <div
              className="progress-bar"
              style={{
                width: `${versions.progress.total ? (versions.progress.completed / versions.progress.total) * 100 : 5}%`
              }}
            />
            <span className="progress-text">
              {versions.progress.completed}/{versions.progress.total} {versions.progress.file}
            </span>
          </div>
        )}
        {versions.installError && <div className="error">安装失败：{versions.installError}</div>}

        <div className="page-sub">已安装</div>
        {versions.installed.length === 0 ? (
          <div className="page-empty">还没有已安装版本，先在上方选一个装吧</div>
        ) : (
          versions.installed.map((id) => (
            <div className="list-row" key={id}>
              <span className="list-row-main mono">{id}</span>
              {id.startsWith('fabric-loader-') ? (
                <span className="chip">Fabric</span>
              ) : (
                <button
                  className="list-row-act"
                  onClick={() => versions.onInstallFabric(id)}
                  disabled={versions.installing}
                  title={`为 ${id} 安装 Fabric 加载器`}
                >
                  装 Fabric
                </button>
              )}
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2>Mods</h2>
        {!instances.selectedMeta ? (
          <div className="page-empty">先在底栏选择或新建版本，再管理 Mods</div>
        ) : (
          <>
            <div className="page-hint">
              操作对象跟随底栏当前版本「{instances.selectedMeta.name}」；隔离开启时装到版本文件夹，关闭时装到根 mods
            </div>
            <div className="row">
              <input
                value={mods.modJarInput}
                onChange={(e) => mods.setModJarInput(e.target.value)}
                placeholder="本地 mod jar 路径（也可让 AI 从 Modrinth 安装）"
              />
              <button onClick={mods.onInstallLocalMod} disabled={!mods.modJarInput.trim()}>
                安装
              </button>
            </div>
            <div className="page-list">
              {mods.mods.length === 0 && (
                <div className="page-empty">mods 目录为空——可以在 AI 助手里说「帮我装 XX mod」</div>
              )}
              {mods.mods.map((m) => (
                <div className="list-row" key={m.filename}>
                  <span className="list-row-main mono">{m.filename}</span>
                  <span className="page-size">{(m.sizeBytes / 1024).toFixed(0)} KB</span>
                  <button className="list-row-act" onClick={() => mods.onRemoveMod(m.filename)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Java 运行时</h2>
        <div className="page-hint">内置运行时按需下载（不写系统环境变量）；手动指定 javaPath 在设置页配置</div>
        {java.runtimes.map((r) => (
          <div className="list-row" key={r.major}>
            <span className="list-row-main mono">Java {r.major}</span>
            <span className="page-ok">已就绪</span>
          </div>
        ))}
        {LTS_MAJORS.filter((m) => !installedMajors.has(m)).map((major) => (
          <div className="list-row" key={major}>
            <span className="list-row-main mono">Java {major}</span>
            <button
              className="list-row-act"
              onClick={() => java.installRuntimeMajor(major)}
              disabled={java.javaDl !== null}
            >
              下载
            </button>
          </div>
        ))}
        {java.javaDl && (
          <>
            <div className="progress">
              <div
                className="progress-bar"
                style={{
                  width: `${java.javaDl.total ? (java.javaDl.completed / java.javaDl.total) * 100 : 5}%`
                }}
              />
              <span className="progress-text">
                {java.javaDl.phase === 'extract' ? '解压中…' : `${java.javaDl.completed}/${java.javaDl.total}`}{' '}
                {java.javaDl.file}
              </span>
            </div>
            <div className="page-actions">
              <button onClick={java.onCancelRuntime}>取消</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>游戏根目录</h2>
        <div className="page-hint">
          启动器读写的 .minecraft 文件夹（版本 / 存档 / mods）。想全新隔离可选 .mmcl 下的新目录；切换需重启生效
        </div>
        <div className="row">
          <span className="game-root-path">{gameRoot.gameRoot || '（未解析）'}</span>
          <button onClick={gameRoot.onPickGameRoot}>更改…</button>
        </div>
      </section>
    </div>
  )
}
