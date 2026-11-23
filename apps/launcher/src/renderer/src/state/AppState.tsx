import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/** 页面路由（UI-DESIGN.md §2：侧栏上入口 = 主页/插件/下载；设置走底栏）。 */
export type Page = 'home' | 'download' | 'extensions' | 'settings'

interface NavigationState {
  page: Page
  navigate: (page: Page) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
}

const NavigationContext = createContext<NavigationState | null>(null)

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Ctrl+B 收起/展开侧栏（仅主页可收，UI-DESIGN.md §2.2）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        if (page === 'home') setSidebarCollapsed((c) => !c)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page])

  return (
    <NavigationContext.Provider
      value={{
        page,
        navigate: setPage,
        sidebarCollapsed,
        toggleSidebar: () => {
          if (page === 'home') setSidebarCollapsed((c) => !c)
        }
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
