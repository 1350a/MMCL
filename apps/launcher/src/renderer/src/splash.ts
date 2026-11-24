import './styles/tokens.css'
import './styles/global.css'
import './splash.css'

/*
 * Splash 页（UI-DESIGN.md §5）：logo + 当前步骤文字 + 细进度条；
 * 单步失败进入错误态（重试 / 仍进主页）；完成淡出交由主进程销毁窗口。
 * 独立入口不挂 React——一张静态卡片的量级不值得引入组件树。
 */

const root = document.getElementById('splash-root') as HTMLElement

root.innerHTML = `
  <div class="splash">
    <div class="splash-logo">MMCL</div>
    <div class="splash-sub">AI 驱动的 Minecraft 启动器</div>
    <div class="splash-progress"><div class="splash-bar"></div></div>
    <div class="splash-step">准备启动…</div>
    <div class="splash-error" hidden>
      <div class="splash-error-text"></div>
      <div class="splash-error-actions">
        <button data-act="retry">重试</button>
        <button data-act="continue">仍进主页</button>
      </div>
    </div>
  </div>
`

const bar = root.querySelector('.splash-bar') as HTMLElement
const stepEl = root.querySelector('.splash-step') as HTMLElement
const errorBox = root.querySelector('.splash-error') as HTMLElement
const errorText = root.querySelector('.splash-error-text') as HTMLElement
const normalEls = [root.querySelector('.splash-progress') as HTMLElement, stepEl]

function render(p: SplashProgressPayload): void {
  bar.style.width = `${Math.max(4, Math.round((p.step / p.total) * 100))}%`
  stepEl.textContent =
    p.state === 'running'
      ? `（${p.step}/${p.total}）${p.label}…`
      : p.state === 'done'
        ? `（${p.step}/${p.total}）${p.label} 完成`
        : p.state === 'background'
          ? `${p.label}：后台进行中，完成后会通知`
          : p.label
  const isError = p.state === 'error'
  errorBox.hidden = !isError
  for (const el of normalEls) el.hidden = isError
  if (isError) {
    errorText.textContent = `${p.label}失败${p.detail ? `：${p.detail}` : ''}`
  }
  if (p.state === 'done' && p.step === p.total) {
    // 全部完成：淡出（窗口随后由主进程销毁）
    document.body.classList.add('splash-out')
  }
}

root.querySelector('[data-act="retry"]')?.addEventListener('click', () => void window.mcl.splashRetry())
root.querySelector('[data-act="continue"]')?.addEventListener('click', () => void window.mcl.splashContinue())

window.mcl.onSplashProgress(render)
