import { useState } from 'react'
import { Modal } from '../ui/Modal'
import type { useInstances } from '../../hooks/useInstances'
import type { useVersions } from '../../hooks/useVersions'

/** 新建版本条目（底栏版本选择器菜单；名字可后改，版本可后绑）。 */
export function NewInstanceDialog({
  instances,
  versions,
  onClose
}: {
  instances: ReturnType<typeof useInstances>
  versions: ReturnType<typeof useVersions>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [creating, setCreating] = useState(false)

  const onCreate = (): void => {
    if (!name.trim() || creating) return
    setCreating(true)
    void (async () => {
      try {
        await instances.onCreateInstanceWith(name.trim(), version || undefined)
        onClose()
      } finally {
        setCreating(false)
      }
    })()
  }

  return (
    <Modal title="新建版本" onClose={onClose} width={440}>
      <div className="dialog-form">
        <label className="dialog-label">版本名</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onCreate()}
          placeholder="如 1.20.1 生存（默认取游戏版本号）"
        />
        <label className="dialog-label">绑定版本（可选）</label>
        <select value={version} onChange={(e) => setVersion(e.target.value)}>
          <option value="">不选，稍后绑定</option>
          {versions.installed.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-actions">
        <button onClick={onClose}>取消</button>
        <button className="dialog-primary" onClick={onCreate} disabled={!name.trim() || creating}>
          创建
        </button>
      </div>
    </Modal>
  )
}
