import { useEffect, useState } from 'react'
import type { Run } from './useRunner'

/** Java 域：本机路径设置、内置运行时列表与下载进度、启动所需版本引导。 */
export function useJava(
  run: Run,
  setMessage: (m: string) => void,
  needJavaMajor: number | null,
  setNeedJavaMajor: (v: number | null) => void
) {
  const [javaPath, setJavaPath] = useState('')
  const [javaInput, setJavaInput] = useState('')
  const [javaInfo, setJavaInfo] = useState<string>('')
  const [runtimes, setRuntimes] = useState<RuntimeInfoPayload[]>([])
  const [javaDl, setJavaDl] = useState<JavaInstallProgressPayload | null>(null)

  useEffect(() => {
    window.mcl.getSettings().then((s) => {
      setJavaPath(s.javaPath)
      setJavaInput(s.javaPath)
      setJavaInfo(s.javaMajor ? `已探测：Java ${s.javaMajor}（${s.javaRaw}）` : s.javaPath ? '探测失败' : '')
    })
    window.mcl.listRuntimes().then(setRuntimes)
    const unsubs = [window.mcl.onJavaInstallProgress((p) => setJavaDl(p))]
    return () => unsubs.forEach((u) => u())
  }, [])

  const onSaveJava = () =>
    run(async () => {
      const s = await window.mcl.setJavaPath(javaInput.trim())
      setJavaPath(s.javaPath)
      setJavaInfo(s.javaMajor ? `已探测：Java ${s.javaMajor}（${s.javaRaw}）` : '')
      setMessage('')
    })

  const onCancelRuntime = () =>
    run(async () => {
      await window.mcl.cancelRuntimeInstall()
      setJavaDl(null) // 取消后不再有进度事件，本地恢复下载按钮
      setMessage('运行时下载已取消（.part 已下部分保留，重下时续传）')
    })

  const onInstallRuntime = () =>
    run(async () => {
      if (needJavaMajor === null) return
      setMessage('')
      await window.mcl.installRuntime(needJavaMajor)
      setJavaDl(null)
      setNeedJavaMajor(null)
      window.mcl.listRuntimes().then(setRuntimes)
      setMessage(`Java ${needJavaMajor} 内置运行时已就绪，请再点一次启动`)
    })

  return {
    javaInput,
    setJavaInput,
    javaInfo,
    runtimes,
    javaDl,
    onSaveJava,
    onCancelRuntime,
    onInstallRuntime
  }
}
