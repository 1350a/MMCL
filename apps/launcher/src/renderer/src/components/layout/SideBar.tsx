import { useNavigation } from '../../state/AppState'
import type { TaskItem } from '../../hooks/useTasks'

function truncate(text: string, max = 16): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 左侧栏（UI-DESIGN.md §2.2）：上半功能入口（主页/插件/下载），
 * 下半任务列表 + 最近对话；仅主页可收起（Ctrl+B），收起时挂件按钮唤回。
 */
export function SideBar({
  collapsed,
  tasks,
  recent,
  onPickRecent
}: {
  collapsed: boolean
  tasks: TaskItem[]
  recent: string[]
  onPickRecent: (text: string) => void
}) {
  const { page, navigate } = useNavigation()
  const running = tasks.filter((t) => t.status === 'running')
  const finished = tasks.filter((t) => t.status !== 'running').slice(-5).reverse()

  return (
    <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
      <nav className="side-nav">
        <button className={page === 'home' ? 'side-item side-item-active' : 'side-item'} onClick={() => navigate('home')}>
          主页
        </button>
        <button
          className={page === 'download' ? 'side-item side-item-active' : 'side-item'}
          onClick={() => navigate('download')}
        >
          下载
        </button>
        <button
          className={page === 'extensions' ? 'side-item side-item-active' : 'side-item'}
          onClick={() => navigate('extensions')}
        >
          插件
        </button>
      </nav>

      <div className="side-panel">
        <div className="side-panel-title">任务</div>
        {tasks.length === 0 && <div className="side-empty">暂无任务</div>}
        {running.map((t) => (
          <div key={t.id} className="side-task">
            <span className="side-task-title">{t.title}</span>
            {t.progress && t.progress.total > 0 && (
              <div className="side-task-bar">
                <div style={{ width: `${Math.round((t.progress.completed / t.progress.total) * 100)}%` }} />
              </div>
            )}
            {t.progress && <span className="side-task-sub">{t.progress.file}</span>}
          </div>
        ))}
        {finished.map((t) => (
          <div key={`${t.id}-${t.at}`} className="side-task side-task-done" title={t.detail}>
            <span className="side-task-title">
              {t.status === 'done' ? '✓' : '✗'} {t.title}
            </span>
          </div>
        ))}
      </div>

      <div className="side-panel">
        <div className="side-panel-title">最近对话</div>
        {recent.length === 0 && <div className="side-empty">暂无对话</div>}
        {recent.map((text, i) => (
          <button key={i} className="side-recent" onClick={() => onPickRecent(text)} title={text}>
            {truncate(text)}
          </button>
        ))}
      </div>

      {/* 弹性占位推到底部：任务与最近对话紧随导航，不沉底（2026-11-23 验收反馈） */}
      <div className="side-flex" />
    </aside>
  )
}
