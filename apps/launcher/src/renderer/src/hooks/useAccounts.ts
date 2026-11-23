import { useEffect, useState } from 'react'
import type { Run } from './useRunner'

/** 账户域：登录表单、当前账户、皮肤头像。 */
export function useAccounts(run: Run, setMessage: (m: string) => void) {
  const [account, setAccount] = useState<AccountPayload | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [authMode, setAuthMode] = useState<'offline' | 'yggdrasil'>('offline')
  const [serverInput, setServerInput] = useState('')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [profileChoices, setProfileChoices] = useState<ProfileChoice[] | null>(null)
  const [selectedProfile, setSelectedProfile] = useState('')
  const [skin, setSkin] = useState<SkinPayload | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)

  useEffect(() => {
    window.mcl.getAccount().then((a) => setAccount(a))
    const unsubs = [
      window.mcl.onAccountChanged((a) => {
        setAccount(a)
        setProfileChoices(null)
        setAuthPassword('')
        setSelectedProfile('')
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  // 外置账户变化时刷新皮肤头像
  useEffect(() => {
    if (account?.kind !== 'yggdrasil') {
      setSkin(null)
      return
    }
    window.mcl.fetchSkin().then((s) => setSkin(s))
  }, [account])

  const onSaveAccount = () =>
    run(async () => {
      await window.mcl.saveAccount(nameInput.trim())
      setAccount(await window.mcl.getAccount())
      setMessage('')
    })

  const onYggdrasilLogin = () =>
    run(async () => {
      setLoggingIn(true)
      try {
        const result = await window.mcl.yggdrasilLogin(serverInput.trim(), authUsername.trim(), authPassword)
        if (result.status === 'select-profile') {
          setProfileChoices(result.profiles)
          setSelectedProfile(result.profiles[0]?.id ?? '')
          setMessage('')
        }
        // status ok 时账户经 event:account-changed 事件回填
      } finally {
        setLoggingIn(false)
      }
    })

  const onSelectProfile = () =>
    run(async () => {
      setLoggingIn(true)
      try {
        await window.mcl.selectProfile(selectedProfile)
        setProfileChoices(null)
        setMessage('')
      } finally {
        setLoggingIn(false)
      }
    })

  const onLogout = () =>
    run(async () => {
      await window.mcl.logoutAccount()
      setMessage('')
    })

  return {
    account,
    nameInput,
    setNameInput,
    authMode,
    setAuthMode,
    serverInput,
    setServerInput,
    authUsername,
    setAuthUsername,
    authPassword,
    setAuthPassword,
    profileChoices,
    selectedProfile,
    setSelectedProfile,
    skin,
    loggingIn,
    onSaveAccount,
    onYggdrasilLogin,
    onSelectProfile,
    onLogout
  }
}
