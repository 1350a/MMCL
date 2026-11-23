import { Modal, useModalClose } from '../ui/Modal'

/** 错误详情弹窗（通知「查看详情」或操作失败时打开）。 */
export function ErrorDialog({ title, detail, onClose }: { title: string; detail: string; onClose: () => void }) {
  const close = useModalClose()
  return (
    <Modal title={title} onClose={onClose} width={480}>
      <p className="dialog-text dialog-error-text">{detail}</p>
      <div className="dialog-actions">
        <button className="dialog-primary" onClick={close}>
          知道了
        </button>
      </div>
    </Modal>
  )
}
