import { useEffect, useState } from 'react'
import type { Run } from './useRunner'

/** 实例域（M6 多实例）：实例列表、选择、创建与删除。 */
export function useInstances(run: Run, setMessage: (m: string) => void) {
  const [instances, setInstances] = useState<InstanceMetaPayload[]>([])
  const [selectedInstance, setSelectedInstance] = useState('')
  const [newInstName, setNewInstName] = useState('')
  const [newInstVersion, setNewInstVersion] = useState('')

  const refreshInstances = (): void => {
    window.mcl.listInstances().then((list) => {
      setInstances(list)
      setSelectedInstance((prev) => (prev && list.some((i) => i.id === prev) ? prev : (list[0]?.id ?? '')))
    })
  }

  useEffect(() => {
    refreshInstances()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedMeta = instances.find((i) => i.id === selectedInstance)

  /** 创建版本条目（新建弹窗用；创建后选中新条目）。 */
  const onCreateInstanceWith = (name: string, versionId?: string): Promise<void> =>
    run(async () => {
      const created = await window.mcl.createInstance({ name, ...(versionId ? { versionId } : {}) })
      setSelectedInstance(created.id)
      refreshInstances()
      setMessage('')
    })

  const onCreateInstance = () => {
    const name = newInstName.trim()
    if (!name) return
    void onCreateInstanceWith(name, newInstVersion || undefined).then(() => {
      setNewInstName('')
      setNewInstVersion('')
    })
  }

  const onDeleteInstance = () =>
    run(async () => {
      const inst = selectedMeta
      if (!inst) return
      if (!window.confirm(`删除实例「${inst.name}（${inst.id}）」？其 mods/存档/设置将不可恢复。`)) return
      await window.mcl.deleteInstance(inst.id)
      refreshInstances()
      setMessage('')
    })

  return {
    instances,
    selectedInstance,
    setSelectedInstance,
    newInstName,
    setNewInstName,
    newInstVersion,
    setNewInstVersion,
    refreshInstances,
    selectedMeta,
    onCreateInstance,
    onCreateInstanceWith,
    onDeleteInstance
  }
}
