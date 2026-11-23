import { Modal, useModalClose } from '../ui/Modal'

/** 通用确认弹窗（删除版本确认②等轻事务）。 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = '确认',
  danger = false,
  onConfirm,
  onClose
}: {
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const close = useModalClose()
  return (
    <Modal title={title} onClose={onClose} width={440}>
      <p className="dialog-text">{body}</p>
      <div className="dialog-actions">
        <button onClick={close}>取消</button>
        <button
          className={danger ? 'dialog-danger' : 'dialog-primary'}
          onClick={() => {
            onConfirm()
            close()
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
