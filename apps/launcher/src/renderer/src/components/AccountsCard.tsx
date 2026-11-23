import type { useAccounts } from '../hooks/useAccounts'

/** 账户卡：离线/外置登录与当前账户展示。 */
export function AccountsCard({ vm }: { vm: ReturnType<typeof useAccounts> }) {
  return (
    <section className="card">
      <h2>账户</h2>
      {!vm.account && (
        <div className="row">
          <select value={vm.authMode} onChange={(e) => vm.setAuthMode(e.target.value as 'offline' | 'yggdrasil')}>
            <option value="offline">离线登录</option>
            <option value="yggdrasil">外置登录（authlib-injector）</option>
          </select>
        </div>
      )}
      {!vm.account && vm.authMode === 'offline' && (
        <div className="row">
          <input
            value={vm.nameInput}
            onChange={(e) => vm.setNameInput(e.target.value)}
            placeholder="玩家名（3-16 位字母/数字/下划线）"
          />
          <button onClick={vm.onSaveAccount} disabled={!vm.nameInput.trim()}>
            保存
          </button>
        </div>
      )}
      {!vm.account && vm.authMode === 'yggdrasil' && (
        <>
          <div className="row">
            <input
              value={vm.serverInput}
              onChange={(e) => vm.setServerInput(e.target.value)}
              placeholder="认证服务器地址（API 根或首页，如 skin.example.com）"
            />
          </div>
          {vm.serverInput.trim().startsWith('http://') && (
            <div className="error">警告：该服务器使用明文 HTTP，密码将不加密传输，存在安全风险</div>
          )}
          <div className="row">
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
              onClick={vm.onYggdrasilLogin}
              disabled={!vm.serverInput.trim() || !vm.authUsername.trim() || !vm.authPassword || vm.loggingIn}
            >
              {vm.loggingIn ? '登录中…' : '登录'}
            </button>
          </div>
          {vm.profileChoices && (
            <div className="row">
              <select value={vm.selectedProfile} onChange={(e) => vm.setSelectedProfile(e.target.value)}>
                {vm.profileChoices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button onClick={vm.onSelectProfile} disabled={!vm.selectedProfile || vm.loggingIn}>
                确认角色
              </button>
            </div>
          )}
        </>
      )}
      {vm.account && (
        <div className="row">
          {vm.skin && (
            <img
              src={vm.skin.url}
              alt="皮肤"
              style={{ height: 64, imageRendering: 'pixelated' }}
            />
          )}
          <div className="result" style={{ flex: 1 }}>
            当前账户：
            {vm.account.kind === 'yggdrasil' ? (
              <>
                {vm.account.name}（外置 ·{' '}
                <span title={vm.account.apiRoot}>{vm.account.serverName ?? vm.account.apiRoot}</span>）
              </>
            ) : (
              `${vm.account.name}（离线）`
            )}
          </div>
          <button onClick={vm.onLogout}>登出</button>
        </div>
      )}
      {!vm.account && <div className="result">当前账户：未创建</div>}
    </section>
  )
}
