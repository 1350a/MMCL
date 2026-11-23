import { useEffect, useRef } from 'react'
import { Modal, useModalClose } from '../ui/Modal'
import type { useAccounts } from '../../hooks/useAccounts'

/**
 * 登录方式三选弹窗（UI-DESIGN.md §2.3 铅笔下拉）：
 * 正版（暂不可实装，禁用态）/ 离线 / 外置登录（authlib-injector）。
 * 已登录状态下打开 = 添加账号流程。
 */
export function LoginMethodDialog({ vm, onClose }: { vm: ReturnType<typeof useAccounts>; onClose: () => void }) {
  const close = useModalClose()
  const accountAtOpen = useRef(vm.account)

  // 登录成功（账户变化）自动关闭；登出到 null 不触发
  useEffect(() => {
    if (vm.account && accountAtOpen.current !== vm.account) close()
  }, [vm.account, close])

  return (
    <Modal title={accountAtOpen.current ? '添加账号' : '选择登录方式'} onClose={onClose} width={520}>
      <div className="login-methods">
        <button className="login-method" disabled title="正版登录暂未实装（UI 已留位）">
          <b>正版登录</b>
          <span>Microsoft 账号 · 未实装</span>
        </button>
        <button
          className={`login-method${vm.authMode === 'offline' ? ' login-method-active' : ''}`}
          onClick={() => vm.setAuthMode('offline')}
        >
          <b>离线登录</b>
          <span>玩家名生成离线 UUID</span>
        </button>
        <button
          className={`login-method${vm.authMode === 'yggdrasil' ? ' login-method-active' : ''}`}
          onClick={() => vm.setAuthMode('yggdrasil')}
        >
          <b>外置登录</b>
          <span>authlib-injector 认证服务器</span>
        </button>
      </div>

      {vm.authMode === 'offline' && (
        <div className="dialog-form">
          <input
            value={vm.nameInput}
            onChange={(e) => vm.setNameInput(e.target.value)}
            placeholder="玩家名（3-16 位字母/数字/下划线）"
            onKeyDown={(e) => e.key === 'Enter' && vm.onSaveAccount()}
          />
          <button className="dialog-primary" onClick={vm.onSaveAccount} disabled={!vm.nameInput.trim()}>
            {accountAtOpen.current ? '添加' : '登录'}
          </button>
        </div>
      )}

      {vm.authMode === 'yggdrasil' && (
        <div className="dialog-form">
          <input
            value={vm.serverInput}
            onChange={(e) => vm.setServerInput(e.target.value)}
            placeholder="认证服务器地址（API 根或首页，如 skin.example.com）"
          />
          {vm.serverInput.trim().startsWith('http://') && (
            <div className="error">警告：该服务器使用明文 HTTP，密码将不加密传输，存在安全风险</div>
          )}
          <div className="dialog-form-row">
            <input
              value={vm.authUsername}
              onChange={(e) => vm.setAuthUsername(e.target.value)}
              placeholder="账号（邮箱或用户名，以服务器要求为准）"
            />
            <input
              type="password"
              value={vm.authPassword}
              onChange={(e) => vm.setAuthPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && vm.onYggdrasilLogin()}
              placeholder="密码"
            />
            <button
              className="dialog-primary"
              onClick={vm.onYggdrasilLogin}
              disabled={!vm.serverInput.trim() || !vm.authUsername.trim() || !vm.authPassword || vm.loggingIn}
            >
              {vm.loggingIn ? '登录中…' : '登录'}
            </button>
          </div>
          {vm.profileChoices && (
            <div className="dialog-form-row">
              <select value={vm.selectedProfile} onChange={(e) => vm.setSelectedProfile(e.target.value)}>
                {vm.profileChoices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="dialog-primary" onClick={vm.onSelectProfile} disabled={!vm.selectedProfile || vm.loggingIn}>
                确认角色
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
