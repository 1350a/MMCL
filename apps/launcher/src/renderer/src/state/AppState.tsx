import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/** 页面路由（UI-DESIGN.md §2：侧栏上入口 = 主页/插件/下载；设置走底栏）。 */
export type Page = 'home' | 'download' | 'extensions' | 'settings'

interface NavigationState {
  page: Page
  navigate: (page: Page) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** 隐藏侧栏（设置页持久开关；隐藏 ≠ 收起，挂件按钮唤回）。 */
  sidebarHidden: boolean
  setSidebarHidden: (hidden: boolean) => void
}

const NavigationContext = createContext<NavigationState | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarHidden, setSidebarHiddenState] = useState(false)

  // 隐藏态从全局配置恢复（ui.sidebarHidden）；切换即落盘
  useEffect(() => {
    window.mcl.getConfig().then((c) => setSidebarHiddenState(c.ui?.sidebarHidden ?? false))
  }, [])

  const setSidebarHidden = (hidden: boolean): void => {
    setSidebarHiddenState(hidden)
    void window.mcl.setConfig({ ui: { sidebarHidden: hidden } })
  }

  // Ctrl+B 收起/展开侧栏（仅主页可收，UI-DESIGN.md §2.2；隐藏态由设置页管理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        if (page === 'home' && !sidebarHidden) setSidebarCollapsed((c) => !c)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page, sidebarHidden])

  return (
    <NavigationContext.Provider
      value={{
        page,
        navigate: setPage,
        sidebarCollapsed,
        toggleSidebar: () => {
          if (page === 'home' && !sidebarHidden) setSidebarCollapsed((c) => !c)
        },
        sidebarHidden,
        setSidebarHidden
      }}
    >
      {children}
    </NavigationContext.Provider>
  )
}

export function useNavigation(): NavigationState {
  const ctx = useContext(NavigationContext)
  if (!ctx) throw new Error('useNavigation 必须在 NavigationProvider 内使用')
  return ctx
}
