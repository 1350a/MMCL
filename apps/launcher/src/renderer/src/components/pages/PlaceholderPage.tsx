/** 落地中的页面占位（C6 下载页 / C7 设置页 / C8 插件页逐笔接入）。 */
export function PlaceholderPage({ title, note }: { title: string; note: string }) {
  return (
    <div className="placeholder-page">
      <h2>{title}</h2>
      <p>{note}</p>
    </div>
  )
}
