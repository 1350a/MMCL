import { useEffect, useRef } from 'react'
import { Modal } from '../ui/Modal'

/** 游戏日志弹窗（通知/任务「打开日志」入口；实时滚动）。 */
export function GameLogDialog({ lines, onClose }: { lines: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines])

  return (
    <Modal title="游戏日志" onClose={onClose} width={720}>
      {lines.length === 0 ? (
        <p className="dialog-text">游戏日志将显示在这里…</p>
      ) : (
        <div className="log dialog-log" ref={ref}>
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </Modal>
  )
}
