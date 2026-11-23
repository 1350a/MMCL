import { useEffect, useState } from 'react'
import type { Run } from './useRunner'

/** 版本域：远端清单、已装版本、安装进度与 Fabric 安装。 */
export function useVersions(run: Run, setMessage: (m: string) => void) {
  const [remoteVersions, setRemoteVersions] = useState<RemoteVersion[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  const [selectedRemote, setSelectedRemote] = useState('')
  const [selectedInstalled, setSelectedInstalled] = useState('')
  const [progress, setProgress] = useState<InstallProgressPayload | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')

  useEffect(() => {
    window.mcl.listRemoteVersions().then(setRemoteVersions)
    window.mcl.listInstalledVersions().then(setInstalled)
    const unsubs = [
      window.mcl.onInstallProgress((p) => setProgress(p)),
      window.mcl.onInstallDone((p) => {
        setInstalling(false)
        setProgress(null)
        if (p.ok) {
          setInstallError('')
          window.mcl.listInstalledVersions().then((list) => {
            setInstalled(list)
            setSelectedInstalled(p.id) // 装完即选中，可直接点启动
          })
        } else {
          setInstallError(p.error ?? '安装失败')
          window.mcl.listInstalledVersions().then(setInstalled)
        }
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  const releases = remoteVersions.filter((v) => v.type === 'release')

  const onInstall = () =>
    run(async () => {
      setInstalling(true)
      setInstallError('')
      setProgress({ completed: 0, total: 0, file: '准备中…' })
      await window.mcl.installVersion(selectedRemote)
      setInstalling(false)
      setProgress(null)
    })

  const onCancelInstall = () =>
    run(async () => {
      await window.mcl.cancelInstall()
      setMessage('安装取消中…')
    })

  const onInstallFabric = (target?: string) =>
    run(async () => {
      const gameVersion = target ?? selectedInstalled
      if (!gameVersion) return
      setInstalling(true)
      setInstallError('')
      setProgress({ completed: 0, total: 0, file: '准备 Fabric…' })
      await window.mcl.installFabric(gameVersion)
      // 完成后经 event:install-done 刷新版本列表并选中新 fabric 版本
    })

  return {
    remoteVersions,
    installed,
    selectedRemote,
    setSelectedRemote,
    selectedInstalled,
    setSelectedInstalled,
    progress,
    installing,
    installError,
    releases,
    onInstall,
    onCancelInstall,
    onInstallFabric
  }
}
