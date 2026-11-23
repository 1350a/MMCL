import { useCallback, useEffect, useReducer } from 'react'

/** 侧栏任务（进行中 + 近期；数据源 = 推送事件 + 命令式登记）。 */
export interface TaskItem {
  id: string
  title: string
  kind: 'install' | 'runtime' | 'game' | 'extension' | 'other'
  status: 'running' | 'done' | 'error'
  progress?: { completed: number; total: number; file: string }
  detail?: string
  at: number
}

/** 右下角 Toast（主进程 event:notify 或渲染层本地登记）。 */
export interface ToastItem {
  id: string
  title: string
  body?: string
  kind: 'info' | 'success' | 'warning' | 'error'
  actions?: Array<{ id: string; label: string }>
}

/** 任务登记/更新载荷（id 相同即更新既有任务）。 */
export type TaskUpsert = Partial<Omit<TaskItem, 'id' | 'title' | 'kind'>> & {
  id: string
  title: string
  kind: TaskItem['kind']
}

type Action =
  | { type: 'task-upsert'; task: TaskUpsert }
  | { type: 'toast-push'; toast: ToastItem }
  | { type: 'toast-dismiss'; id: string }

interface TaskState {
  tasks: TaskItem[]
  toasts: ToastItem[]
}

const MAX_FINISHED_TASKS = 12
const MAX_TOASTS = 5

function reducer(state: TaskState, action: Action): TaskState {
  switch (action.type) {
    case 'task-upsert': {
      const at = Date.now()
      const prev = state.tasks.find((t) => t.id === action.task.id)
      const merged: TaskItem = {
        at: prev?.at ?? at,
        status: 'running',
        ...prev,
        ...action.task,
        progress: action.task.progress ?? prev?.progress
      }
      const rest = state.tasks.filter((t) => t.id !== merged.id)
      // 运行中的置顶，已结束的排后并截断保留近期
      const running = [merged, ...rest.filter((t) => t.status === 'running')]
      const finished = rest.filter((t) => t.status !== 'running')
      const tasks = [...running, ...finished].slice(0, 20)
      const visibleFinished = tasks.filter((t) => t.status !== 'running').length
      return {
        ...state,
        tasks:
          visibleFinished > MAX_FINISHED_TASKS
            ? [...tasks.filter((t) => t.status === 'running'), ...tasks.filter((t) => t.status !== 'running').slice(0, MAX_FINISHED_TASKS)]
            : tasks
      }
    }
    case 'toast-push':
      return { ...state, toasts: [...state.toasts, action.toast].slice(-MAX_TOASTS) }
    case 'toast-dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}

/** 通知/任务中枢：订阅推送事件维护任务列表，主进程通知转 Toast。 */
export function useTasks(): {
  tasks: TaskItem[]
  toasts: ToastItem[]
  upsertTask: (task: TaskUpsert) => void
  pushToast: (toast: Omit<ToastItem, 'id'> & { id?: string }) => void
  dismissToast: (id: string) => void
} {
  const [state, dispatch] = useReducer(reducer, { tasks: [], toasts: [] })

  useEffect(() => {
    const unsubs = [
      window.mcl.onInstallProgress((p) => {
        dispatch({
          type: 'task-upsert',
          task: { id: 'install', title: '版本安装', kind: 'install', status: 'running', progress: p }
        })
      }),
      window.mcl.onInstallDone((p) => {
        dispatch({
          type: 'task-upsert',
          task: {
            id: 'install',
            title: '版本安装',
            kind: 'install',
            status: p.ok ? 'done' : 'error',
            ...(p.ok ? {} : { detail: p.error })
          }
        })
      }),
      window.mcl.onJavaInstallProgress((p) => {
        dispatch({
          type: 'task-upsert',
          task: { id: 'runtime', title: '内置运行时下载', kind: 'runtime', status: 'running', progress: p }
        })
      }),
      window.mcl.onGameExit(({ code }) => {
        dispatch({
          type: 'task-upsert',
          task: {
            id: 'game',
            title: '游戏运行',
            kind: 'game',
            status: code === 0 ? 'done' : 'error',
            ...(code === 0 ? {} : { detail: `退出码 ${code}` })
          }
        })
      }),
      window.mcl.onNotify((p) => {
        dispatch({ type: 'toast-push', toast: { ...p, id: p.id || `${Date.now()}-${Math.random()}` } })
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // 回调保持稳定引用（dispatch 恒定）：Toast 等组件以 effect 依赖使用，引用抖动会重置计时器
  const upsertTask = useCallback((task: TaskUpsert) => dispatch({ type: 'task-upsert', task }), [])
  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'> & { id?: string }) =>
      dispatch({ type: 'toast-push', toast: { id: `${Date.now()}-${Math.random()}`, ...toast } }),
    []
  )
  const dismissToast = useCallback((id: string) => dispatch({ type: 'toast-dismiss', id }), [])

  return { tasks: state.tasks, toasts: state.toasts, upsertTask, pushToast, dismissToast }
}
