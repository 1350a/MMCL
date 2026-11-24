/**
 * 面向 AI 的扩展 API 文档（M5-5）：随 aiSystemPrompt 注入，generate_extension 工具的
 * 产出规范以此为准。与宿主实现同步维护（sandbox.ts 注入形状 / consistency.ts 一致性规则）。
 */
export const EXTENSION_API_DOC = `## 扩展开发指南（generate_extension）

用户请你写启动器扩展时，调用 generate_extension 提交（manifest + code）。提交并通过静态检查后会保存到扩展目录；
默认不装载，用户需在插件页手动启用（设置开启「自动加载」时立即生效）。校验失败时错误信息会返回给你，修正后可重新提交。

### manifest 格式（generate_extension 的 manifest 参数）
{
  "id": "my.dice",              // 目录名形态：字母/数字/._-，不以 builtin. 开头；更新已有扩展时 id 必须不变
  "name": "骰子扩展",            // 显示名
  "version": "0.1.0",           // 更新时递增
  "capabilities": ["ai.tools"], // 能力声明，必须与代码实际访问的能力完全一致（双向校验）
  "requires": [],               // 可选协效应：game.notRunning / ai.configured / instance.exists:<id>
  "fsInstances": ["main"],      // 声明 fs.instance 时必填：允许读写的实例 id
  "netDomains": ["api.example.com"] // 声明 net.domains 时必填：精确域名白名单（无通配/端口）
}

### 能力词汇表（capabilities 只能取这些）
- ai.tools：注册 AI 工具（进对话工具面）
- ui.panel：挂载声明式面板（渲染层展示）
- game.hooks：启动前/退出后钩子
- fs.instance：限定实例目录内的文件读写
- net.domains：域名白名单内的 HTTP 请求

### 代码规范（generate_extension 的 code 参数，TypeScript）
- 入口：export function activate(ctx) 或 export async function activate(ctx)
- 能力一律方括号访问：ctx.capabilities['ui.panel']（能力 id 含点，点号访问取不到；也别别名截取
  ctx.capabilities 存变量——静态一致性检查按 ctx.capabilities['X'] 形态扫描，别名会判声明未用而拒绝）
- 沙箱内无 Node、无全局 fetch/fs/import：一切系统能力经 ctx.capabilities；无法访问的能力键不存在
- 资源限制：单次计算窗口约 1 秒墙钟、内存约 32MB；宿主 I/O 悬挂不占时间片，可放心 await

### 能力 API 形状
1. ai.tools —— ctx.capabilities['ai.tools'].registerTool({
     name: 'my.dice.roll',                 // 全局唯一！建议 <扩展id>.<工具名>，与内置 demo 或其他扩展撞名会使本扩展激活失败
     description: '掷骰子',
     parameters: { type: 'object', properties: { sides: { type: 'number' } } }, // JSON Schema
     handler(args) { return JSON.stringify({ ok: true }) }  // 可 async；必须返回 JSON 字符串
   })
2. ui.panel —— ctx.capabilities['ui.panel'].mountPanel({
     title: '统计',
     items: [
       { type: 'text', content: '说明文字' },
       { type: 'kv', rows: { 键: '值' } },
       { type: 'button', label: '按钮', action: 'roll' }   // 点击回流 onAction('roll')
     ]
   }, async function onAction(action) { /* 处理按钮 */ })
   // 重复 mountPanel 即更新面板；activate 里挂一次即可，onAction 里自行重挂刷新
3. game.hooks —— ctx.capabilities['game.hooks'].onBeforeLaunch(ctx => { ... return ['-Xmx2G'] })
   （返回 string[] 追加 JVM 参数；抛错 = 否决启动）；onAfterExit(ctx => { ... })（退出码 ctx.code）
4. fs.instance —— ctx.capabilities['fs.instance'].read/write/list/remove(instanceId, relPath)
   （write 需要 (instanceId, relPath, content)；路径限实例目录内，越界即拒；写/删留补偿记录）
5. net.domains —— ctx.capabilities['net.domains'].httpRequest(url, { method?, headers?, body? })
   （仅 GET/POST；域名须在白名单内；返回 { status, body }，超 30s / 1MB 截断）

### 最小示例（骰子工具 + 按钮）
manifest: { "id": "my.dice", "name": "骰子", "version": "0.1.0", "capabilities": ["ai.tools", "ui.panel"], "requires": [] }
code:
let count = 0
export function activate(ctx) {
  ctx.capabilities['ai.tools'].registerTool({
    name: 'my.dice.roll',
    description: '掷骰子，参数 sides（默认 6）',
    parameters: { type: 'object', properties: { sides: { type: 'number' } } },
    handler(args) {
      count++
      const sides = typeof args.sides === 'number' ? args.sides : 6
      return JSON.stringify({ roll: 1 + Math.floor(Math.random() * sides), count: count })
    }
  })
  ctx.capabilities['ui.panel'].mountPanel(
    { title: '骰子', items: [{ type: 'button', label: '掷一次', action: 'roll' }] },
    function () {}
  )
}
`
