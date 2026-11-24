import { useEffect, useState } from 'react'
import type { useAi } from '../../hooks/useAi'
import type { useJava } from '../../hooks/useJava'
import type { Run } from '../../hooks/useRunner'
import { useNavigation } from '../../state/AppState'
import { JavaRuntimes } from '../JavaRuntimes'

const TABS = [
  { id: 'appearance', label: '外观' },
  { id: 'versions', label: '版本与隔离' },
  { id: 'java', label: 'Java' },
  { id: 'network', label: '网络' },
  { id: 'general', label: '通用' }
] as const

type SettingsTab = (typeof TABS)[number]['id']

/** 设置项变更确认（复用 App 级 ConfirmDialog；与弹窗时机①/②同一通道）。 */
interface SettingsConfirmRequest {
  title: string
  body: string
  danger?: boolean
  confirmLabel?: string
  onConfirm: () => void
}

/**
 * 设置页（UI-DESIGN.md §2.4）：左侧分组导航 + 右侧内容面板，底栏齿轮直达。
 * 分组：外观 / 版本与隔离 / Java / 网络 / 通用；每项读写 mmcl.json（config:get/set）。
 */
export function SettingsPage({
  java,
  ai,
  run,
  backgroundActive,
  onBackgroundChanged,
  onConfirm
}: {
  java: ReturnType<typeof useJava>
  ai: ReturnType<typeof useAi>
  run: Run
  /** 当前是否在用自定义背景（App 持有 data URL）。 */
  backgroundActive: boolean
  onBackgroundChanged: (dataUrl: string | null) => void
  onConfirm: (req: SettingsConfirmRequest) => void
}) {
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [config, setConfig] = useState<ConfigPayload | null>(null)
  const [version, setVersion] = useState('')
  const { sidebarHidden, setSidebarHidden } = useNavigation()

  useEffect(() => {
    window.mcl.getConfig().then(setConfig)
    window.mcl.getVersion().then(setVersion)
  }, [])

  const saveConfig = (patch: ConfigPatchPayload): void => {
    void run(async () => {
      setConfig(await window.mcl.setConfig(patch))
    })
  }

  /** 全局隔离策略：先预览翻转清单，有受影响版本 → 确认弹窗后才落盘（§3 弹窗时机①）。 */
  const onPickStrategy = (next: IsolationStrategyPayload): void => {
    if (!config || next === (config.isolationStrategy ?? 'all')) return
    void run(async () => {
      const affected = await window.mcl.previewIsolation(next)
      if (affected.length === 0) {
        setConfig(await window.mcl.setConfig({ isolationStrategy: next }))
        return
      }
      const lines = affected.map(
        (a) => `· ${a.name}（${a.versionId ?? '未绑定版本'}）：${a.from ? '隔离' : '共享'} → ${a.to ? '隔离' : '共享'}`
      )
      onConfirm({
        title: '变更全局隔离策略',
        body: `以下「跟随全局」的版本有效隔离将翻转：\n${lines.join('\n')}\n\n隔离关闭后存档 / mods 回到根 .minecraft 共享；明确指定过每版本策略的条目不受影响。确定应用？`,
        confirmLabel: '应用',
        onConfirm: () => saveConfig({ isolationStrategy: next })
      })
    })
  }

  const onPickUpdates = (next: NonNullable<ConfigPayload['updates']>): void => {
    if (!config || next === (config.updates ?? 'notify')) return
    if (next !== 'off') {
      saveConfig({ updates: next })
      return
    }
    onConfirm({
      title: '关闭更新检查',
      body: '之后启动器不再检查新版本；需要时可在设置里重新开启。确定关闭？',
      confirmLabel: '关闭更新检查',
      onConfirm: () => saveConfig({ updates: 'off' })
    })
  }

  const onChangeBackground = (): void => {
    void run(async () => {
      const picked = await window.mcl.pickImage()
      if (!picked) return // 用户取消
      onBackgroundChanged(picked.dataUrl)
    })
  }

  const onClearBackground = (): void => {
    void run(async () => {
      setConfig(await window.mcl.setConfig({ ui: { backgroundPath: '' } }))
      onBackgroundChanged(null)
    })
  }

  if (!config) {
    return (
      <div className="page">
        <div className="page-empty">设置加载中…</div>
      </div>
    )
  }

  const aiDisabled = config.ui?.aiDisabled ?? false

  return (
    <div className="page settings-page">
      <div className="settings">
        <nav className="settings-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'settings-nav-item settings-nav-active' : 'settings-nav-item'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {tab === 'appearance' && (
            <section className="card">
              <h2>外观</h2>
              <div className="settings-toggle">
                <div className="settings-toggle-main">
                  <div className="settings-toggle-label">自定义背景</div>
                  <div className="settings-toggle-sub">
                    {backgroundActive ? '正在使用自定义图片（存于 .mmcl\\background）' : '当前使用内置背景图'}
                  </div>
                </div>
                <div className="settings-toggle-act">
                  <button onClick={onChangeBackground}>选择图片…</button>
                  {backgroundActive && <button onClick={onClearBackground}>恢复默认</button>}
                </div>
              </div>
              <div className="settings-toggle">
                <div className="settings-toggle-main">
                  <div className="settings-toggle-label">隐藏侧栏</div>
                  <div className="settings-toggle-sub">隐藏会持久记住，可用左上角挂件按钮唤回（≠ Ctrl+B 收起）</div>
                </div>
                <input
                  type="checkbox"
                  checked={sidebarHidden}
                  onChange={(e) => setSidebarHidden(e.target.checked)}
                />
              </div>
              <div className="settings-toggle">
                <div className="settings-toggle-main">
                  <div className="settings-toggle-label">启用 AI 助手</div>
                  <div className="settings-toggle-sub">关闭后主页只显示背景（中心区留白）</div>
                </div>
                <input
                  type="checkbox"
                  checked={!aiDisabled}
                  onChange={(e) => saveConfig({ ui: { aiDisabled: !e.target.checked } })}
                />
              </div>
            </section>
          )}

          {tab === 'versions' && (
            <section className="card">
              <h2>版本与隔离</h2>
              <div className="settings-field">
                <label>全局隔离策略</label>
                <select
                  value={config.isolationStrategy ?? 'all'}
                  onChange={(e) => onPickStrategy(e.target.value as IsolationStrategyPayload)}
                >
                  <option value="all">全部开启（默认）</option>
                  <option value="none">全部关闭</option>
                  <option value="snapshotOnly">仅隔离快照版</option>
                  <option value="modOnly">仅隔离 mod 版</option>
                  <option value="snapshotAndMod">隔离快照版和 mod 版</option>
                </select>
                <div className="settings-hint">
                  隔离决定存档 / mods / 设置是否随版本独立；assets / libraries / 版本本体永远共享。每版本可在底栏版本设置里覆盖。
                </div>
              </div>
              <div className="settings-toggle">
                <div className="settings-toggle-main">
                  <div className="settings-toggle-label">版本本体自动清理</div>
                  <div className="settings-toggle-sub">删除版本条目时，无其他引用的 versions/ 本体一并清理</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.autoCleanupVersions !== false}
                  onChange={(e) => saveConfig({ autoCleanupVersions: e.target.checked })}
                />
              </div>
            </section>
          )}

          {tab === 'java' && (
            <section className="card">
              <h2>Java</h2>
              <div className="settings-field">
                <label>java.exe 路径（留空自动探测 PATH / JAVA_HOME）</label>
                <div className="row">
                  <input
                    value={java.javaInput}
                    onChange={(e) => java.setJavaInput(e.target.value)}
                    placeholder="C:\\Program Files\\Java\\…\\java.exe"
                  />
                  <button onClick={java.onSaveJava}>保存并探测</button>
                </div>
                {java.javaInfo && <div className="result">{java.javaInfo}</div>}
              </div>
              <div className="page-sub">内置运行时</div>
              <JavaRuntimes java={java} />
              <div className="settings-toggle settings-disabled">
                <div className="settings-toggle-main">
                  <div className="settings-toggle-label">自动获取运行时（按版本引导）</div>
                  <div className="settings-toggle-sub">启动缺 Java 时自动下载对应内置运行时</div>
                </div>
                <span className="settings-badge">未实装</span>
              </div>
            </section>
          )}

          {tab === 'network' && (
            <section className="card">
              <h2>网络</h2>
              <div className="settings-field">
                <label>下载源偏好</label>
                <label className="settings-radio-row">
                  <input
                    type="radio"
                    name="download-source"
                    checked={(config.downloadSource ?? 'official') === 'official'}
                    onChange={() => saveConfig({ downloadSource: 'official' })}
                  />
                  官方源（默认，官方优先）
                </label>
                <label className="settings-radio-row">
                  <input
                    type="radio"
                    name="download-source"
                    checked={config.downloadSource === 'bmclapi'}
                    onChange={() => saveConfig({ downloadSource: 'bmclapi' })}
                  />
                  BMCLAPI 镜像（清单优先走镜像，官方兜底）
                </label>
                <div className="settings-hint">
                  官方源失败时启动器会通知「转用 BMCLAPI 镜像」，点击才切换（不静默）；库文件下载始终带镜像回退。
                </div>
              </div>
            </section>
          )}

          {tab === 'general' && (
            <>
              <section className="card">
                <h2>AI 配置</h2>
                <div className="settings-field">
                  <label>baseURL</label>
                  <input
                    value={ai.aiBase}
                    onChange={(e) => ai.setAiBase(e.target.value)}
                    placeholder="如 https://api.deepseek.com"
                  />
                </div>
                <div className="settings-field">
                  <label>API Key</label>
                  <input
                    type="password"
                    value={ai.aiKey}
                    onChange={(e) => ai.setAiKey(e.target.value)}
                    placeholder={ai.aiConfig?.apiKeyMasked || '未配置'}
                  />
                </div>
                <div className="settings-field">
                  <label>模型</label>
                  <input
                    value={ai.aiModel}
                    onChange={(e) => ai.setAiModel(e.target.value)}
                    placeholder="如 deepseek-chat"
                  />
                </div>
                <div className="page-actions">
                  <button onClick={ai.onSaveAiConfig}>保存配置</button>
                </div>
              </section>

              <section className="card">
                <h2>更新检查</h2>
                <div className="settings-field">
                  <select
                    value={config.updates ?? 'notify'}
                    onChange={(e) => onPickUpdates(e.target.value as NonNullable<ConfigPayload['updates']>)}
                  >
                    <option value="auto">检查并自动更新</option>
                    <option value="notify">检查并提醒更新（默认）</option>
                    <option value="notifyImportant">检查并仅提醒重要更新</option>
                    <option value="off">不检查更新</option>
                  </select>
                  <div className="settings-hint">更新服务器未实装，当前仅落地偏好（启动管线第 5 步留位）。</div>
                </div>
              </section>

              <section className="card">
                <h2>关于</h2>
                <div className="settings-about">
                  <div className="settings-about-title">MMCL v{version || '…'}</div>
                  <div>非官方第三方启动器，与 Mojang Studios / Microsoft 无关联。</div>
                  <div>开源许可：ISC。</div>
                  <div>内置素材（背景图等）权利归原权利人；协议与素材声明文本定稿前以占位展示。</div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
