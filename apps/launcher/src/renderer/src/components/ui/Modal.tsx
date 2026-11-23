import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

const ModalCloseContext = createContext<() => void>(() => undefined)

/** 在弹窗内部触发关闭（走退场动画）。 */
export function useModalClose(): () => void {
  return useContext(ModalCloseContext)
}

/**
 * 应用内弹窗基座（UI-DESIGN.md §1 弹窗原则）：玻璃面板、入场/退场动画、ESC/遮罩关闭。
 * 退场动画完成后才真正卸载（onClose）。
 */
export function Modal({
  title,
  onClose,
  children,
  width
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  const close = useCallback((): void => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(onClose, 220) // 与 modal-out 动画时长一致
  }, [onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <ModalCloseContext.Provider value={close}>
      <div
        className={closing ? 'modal-overlay modal-closing' : 'modal-overlay'}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close()
        }}
      >
        <div className="modal-panel" style={width ? { width } : undefined}>
          <div className="modal-head">
            <h3>{title}</h3>
            <button className="modal-close" onClick={close} title="关闭">
              ✕
            </button>
          </div>
          <div className="modal-body">{children}</div>
        </div>
      </div>
    </ModalCloseContext.Provider>
  )
}
