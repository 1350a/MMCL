import type { useJava } from '../hooks/useJava'

/** 常用 LTS 运行时快速下载项（MC 生态主流：1.16- 多为 8，1.17~1.20.4 为 17，1.20.5+ 为 21）。 */
const LTS_MAJORS = [8, 17, 21]

/**
 * 内置 Java 运行时列表 + 一键下载（下载页与设置页 Java 组共用同一段）。
 * 进度同时进侧栏任务列表与页面内联条（§6）；javaPath 手动配置不在这里。
 */
export function JavaRuntimes({ java }: { java: ReturnType<typeof useJava> }) {
  const installedMajors = new Set(java.runtimes.map((r) => r.major))

  return (
    <>
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
    </>
  )
}
