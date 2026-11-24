/** 自绘顶栏（UI-DESIGN.md §7）：内容区拖拽，系统渲染 ─ □ ✕（右侧留白由 CSS 控制）。 */
export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar-logo">MMCL</span>
      <span className="titlebar-hint" />
    </header>
  )
}
