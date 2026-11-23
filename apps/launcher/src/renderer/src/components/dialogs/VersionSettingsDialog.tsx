import { useEffect, useState } from 'react'
import { Modal, useModalClose } from '../ui/Modal'
import type { useVersions } from '../../hooks/useVersions'
import type { useInstances } from '../../hooks/useInstances'

/**
 * 版本设置弹窗（底栏版本选择器展开进入，UI-DESIGN.md §3 双层层叠）：
 * 重命名 / 版本绑定 / 每版本隔离策略（默认跟随全局）/ 删除版本。
 */
export function VersionSettingsDialog({
  instance,
  versions,
  instances,
  onDeleteRequest,
  onClose
}: {
  instance: InstanceMetaPayload
  versions: ReturnType<typeof useVersions>
  instances: ReturnType<typeof useInstances>
  onDeleteRequest: (inst: InstanceMetaPayload) => void
  onClose: () => void
}) {
  const close = useModalClose()
  const [name, setName] = useState(instance.name)
  const [bindVersion, setBindVersion] = useState(instance.versionId ?? '')
  const [isolation, setIsolation] = useState<string>(instance.isolation ?? 'follow')
  const [saving, setSaving] = useState(false)

  // 深层弹窗（确认删除）后的关闭由父级驱动；这里只管保存
  useEffect(() => {
    setName(instance.name)
    setBindVersion(instance.versionId ?? '')
    setIsolation(instance.isolation ?? 'follow')
  }, [instance])

  const onSave = (): void => {
    setSaving(true)
    void (async () => {
      try {
        if (name.trim() && name.trim() !== instance.name) {
          await window.mcl.updateInstance(instance.id, { name: name.trim() })
        }
        if (bindVersion !== (instance.versionId ?? '')) {
          if (bindVersion === '') {
            // 解绑暂不支持（启动需要版本），保持原绑定
          } else {
            await window.mcl.setInstanceVersion(instance.id, bindVersion)
          }
        }
        if (isolation !== (instance.isolation ?? 'follow')) {
          await window.mcl.updateInstance(instance.id, { isolation })
        }
        instances.refreshInstances()
        close()
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <Modal title={`版本设置 · ${instance.name}`} onClose={onClose} width={480}>
      <div className="dialog-form">
        <label className="dialog-label">名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="版本名（可改名）" />
        <label className="dialog-label">绑定版本</label>
        <select value={bindVersion} onChange={(e) => setBindVersion(e.target.value)}>
          <option value="">{instance.versionId ? `${instance.versionId}（当前绑定）` : '选择已安装版本…'}</option>
          {versions.installed.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <label className="dialog-label">版本隔离</label>
        <select value={isolation} onChange={(e) => setIsolation(e.target.value)}>
          <option value="follow">跟随全局</option>
          <option value="all">全部开启</option>
          <option value="none">全部关闭</option>
          <option value="snapshotOnly">仅隔离快照版</option>
          <option value="modOnly">仅隔离 mod 版</option>
          <option value="snapshotAndMod">隔离快照版和 mod 版</option>
        </select>
        <div className="dialog-hint">
          隔离决定存档 / mods / 设置是否随版本独立；assets / libraries / 版本本体永远共享。
        </div>
      </div>
      <div className="dialog-actions">
        <button onClick={onClose}>取消</button>
        <button className="dialog-primary" onClick={onSave} disabled={saving || !name.trim()}>
          保存
        </button>
      </div>
      <div className="dialog-danger-zone">
        <button
          className="dialog-danger-outline"
          onClick={() => {
            close() // 本弹窗走退场动画，确认弹窗由父级打开
            onDeleteRequest(instance)
          }}
        >
          删除此版本…
        </button>
      </div>
    </Modal>
  )
}
