import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastItem } from '../../hooks/useTasks'

const AUTO_DISMISS_MS: Record<ToastItem['kind'], number> = {
  info: 4500,
  success: 4500,
  warning: 10000,
  error: 10000
}
const EXIT_ANIM_MS = 200

function Toast({
  toast,
  onDismiss,
  onAction
}: {
  toast: ToastItem
  onDismiss: (id: string) => void
  onAction: (toast: ToastItem, actionId: string) => void
}) {
  const [leaving, setLeaving] = useState(false)
  const leavingRef = useRef(false)
  const requestDismiss = useCallback((): void => {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    setTimeout(() => onDismiss(toast.id), EXIT_ANIM_MS) // 退场动画后真正移除
  }, [onDismiss, toast.id])

  // 自动消失：警告/错误停留更久
  useEffect(() => {
    const timer = setTimeout(requestDismiss, AUTO_DISMISS_MS[toast.kind])
    return () => clearTimeout(timer)
  }, [requestDismiss, toast.kind])

  return (
    <div className={leaving ? 'toast toast-leaving' : `toast toast-${toast.kind}`}>
      <div className="toast-main">
        <div className="toast-title">{toast.title}</div>
        {toast.body && <div className="toast-body">{toast.body}</div>}
      </div>
      <div className="toast-actions">
        {toast.actions?.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              onAction(toast, a.id)
              requestDismiss()
            }}
          >
            {a.label}
          </button>
        ))}
        <button className="toast-close" onClick={requestDismiss} title="关闭">
          ✕
        </button>
      </div>
    </div>
  )
}

/** 右下角 IDE 式通知栈（UI-DESIGN.md §6）：堆叠、弹性滑入、滑出退场、可带动作按钮。 */
export function ToastStack({
  toasts,
  onDismiss,
  onAction
}: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
  onAction: (toast: ToastItem, actionId: string) => void
}) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} onAction={onAction} />
      ))}
    </div>
  )
}
