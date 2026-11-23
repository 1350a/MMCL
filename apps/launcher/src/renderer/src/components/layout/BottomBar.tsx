import { useState } from 'react'
import type { useAccounts } from '../../hooks/useAccounts'
import type { useInstances } from '../../hooks/useInstances'
import type { useGame } from '../../hooks/useGame'
import type { Page } from '../../state/AppState'

interface ConfirmRequest {
  title: string
  body: string
  danger?: boolean
  confirmLabel?: string
  onConfirm: () => void
}

/**
 * 底栏（UI-DESIGN.md §2.3）：左 = 头像 + 铅笔下拉（多账户）；右 = 设置、
 * 版本选择器（展开含版本设置/新建）+ 启动按钮三态（启动 / 停止无确认 / 下载游戏）。
 */
export function BottomBar({
  accounts,
  instances,
  game,
  onLaunch,
  onOpenLogin,
  onOpenVersionSettings,
  onOpenNewInstance,
  onConfirm,
  navigate
}: {
  accounts: ReturnType<typeof useAccounts>
  instances: ReturnType<typeof useInstances>
  game: ReturnType<typeof useGame>
  onLaunch: () => void
  onOpenLogin: () => void
  onOpenVersionSettings: (inst: InstanceMetaPayload) => void
  onOpenNewInstance: () => void
  onConfirm: (req: ConfirmRequest) => void
  navigate: (page: Page) => void
}) {
  const [accountMenu, setAccountMenu] = useState(false)
  const [versionMenu, setVersionMenu] = useState(false)
  const [accountList, setAccountList] = useState<AccountListItemPayload[]>([])

  const account = accounts.account
  const currentId = account ? account.uuid || account.name : ''
  const selectedMeta = instances.selectedMeta

  const toggleAccountMenu = (): void => {
    if (!accountMenu) void window.mcl.listAccounts().then(setAccountList)
    setAccountMenu((v) => !v)
  }

  // 停止无确认（UI-DESIGN.md §2.3）
  const stopGame = (): void => {
    void window.mcl.stopGame()
  }

  const launchClass = game.gameRunning
    ? 'bb-launch bb-launch-stop'
    : !selectedMeta?.versionId
      ? 'bb-launch bb-launch-empty'
      : 'bb-launch'
  const launchLabel = game.gameRunning ? '停止游戏' : !selectedMeta?.versionId ? '下载游戏' : '启动游戏'
  const launchSub = game.gameRunning
    ? '点击立即停止（无确认）'
    : !selectedMeta?.versionId
      ? '没有可用的游戏版本'
      : `启动 ${selectedMeta.versionId}`
  const launchAction = game.gameRunning ? stopGame : !selectedMeta?.versionId ? () => navigate('download') : onLaunch

  return (
    <footer className="bottombar">
      <div className="bb-left">
        <div className="bb-avatar">
          {accounts.skin ? (
            <img src={accounts.skin.url} alt="皮肤头像" />
          ) : (
            <span>{account ? account.name.slice(0, 1) : '?'}</span>
          )}
        </div>
        <div className="bb-account">
          <div className="bb-name">{account ? account.name : '未登录'}</div>
          <div className="bb-sub">
            {account ? (account.kind === 'yggdrasil' ? `外置 · ${account.serverName ?? account.apiRoot}` : '离线') : '点击铅笔选择登录方式'}
          </div>
        </div>
        <button className="bb-pencil" onClick={toggleAccountMenu} title="账号管理">
          ✎
        </button>
        {accountMenu && (
          <div className="bb-menu">
            <div className="bb-menu-title">切换账号</div>
            {accountList.length === 0 && <div className="side-empty">（暂无账号）</div>}
            {accountList.map((a) => (
              <div key={a.id} className="bb-menu-row">
                <button
                  className={a.id === currentId ? 'bb-menu-main bb-menu-active' : 'bb-menu-main'}
                  onClick={() => {
                    setAccountMenu(false)
                    if (a.id !== currentId) void window.mcl.switchAccount(a.id)
                  }}
                >
                  {a.name}（{a.kind === 'offline' ? '离线' : '外置'}）{a.id === currentId ? ' · 当前' : ''}
                </button>
                <button
                  className="bb-menu-act"
                  title="删除账号"
                  onClick={() => {
                    setAccountMenu(false)
                    onConfirm({
                      title: '删除账号',
                      body: `删除「${a.name}」？外置账号的 token 将被吊销。`,
                      danger: true,
                      confirmLabel: '删除',
                      onConfirm: () => void window.mcl.deleteAccount(a.id)
                    })
                  }}
                >
                  删
                </button>
              </div>
            ))}
            <button
              className="bb-menu-add"
              onClick={() => {
                setAccountMenu(false)
                onOpenLogin()
              }}
            >
              ＋ 添加账号
            </button>
          </div>
        )}
      </div>

      <div className="bb-right">
        <button className="bb-gear" onClick={() => navigate('settings')} title="设置">
          ⚙
        </button>
        <div className="bb-version">
          <button className="bb-version-btn" onClick={() => setVersionMenu((v) => !v)}>
            <div className="bb-name">{selectedMeta ? selectedMeta.name : '选择版本'}</div>
            <div className="bb-sub">{selectedMeta ? (selectedMeta.versionId ?? '未绑定版本') : '尚无版本条目'}</div>
          </button>
          {versionMenu && (
            <div className="bb-menu bb-menu-up">
              {instances.instances.length === 0 && <div className="side-empty">（暂无版本条目）</div>}
              {instances.instances.map((inst) => (
                <div key={inst.id} className="bb-menu-row">
                  <button
                    className={inst.id === instances.selectedInstance ? 'bb-menu-main bb-menu-active' : 'bb-menu-main'}
                    onClick={() => {
                      instances.setSelectedInstance(inst.id)
                      setVersionMenu(false)
                    }}
                  >
                    {inst.name}（{inst.versionId ?? '未绑定'}）
                  </button>
                  <button
                    className="bb-menu-act"
                    title="版本设置"
                    onClick={() => {
                      setVersionMenu(false)
                      onOpenVersionSettings(inst)
                    }}
                  >
                    ⚙
                  </button>
                </div>
              ))}
              <button
                className="bb-menu-add"
                onClick={() => {
                  setVersionMenu(false)
                  onOpenNewInstance()
                }}
              >
                ＋ 新建版本
              </button>
            </div>
          )}
        </div>
        <button className={launchClass} onClick={launchAction}>
          <div className="bb-launch-main">{launchLabel}</div>
          <div className="bb-sub">{launchSub}</div>
        </button>
      </div>
    </footer>
  )
}
