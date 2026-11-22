import type { ExtensionManifest } from './loader'

/**
 * 示例扩展（M5-4 dogfooding）：dice_roll 工具 + 声明式统计面板（ui.panel）。
 * 首次运行写入用户扩展目录，此后与用户扩展走完全相同的装载管线。
 */
export const DEMO_EXTENSION_FILES: { manifest: ExtensionManifest; indexTs: string } = {
  manifest: {
    id: 'sandbox.demo',
    name: '示例沙箱扩展',
    version: '0.2.0',
    capabilities: ['ai.tools', 'ui.panel'],
    requires: []
  },
  indexTs: `// 示例扩展：掷骰子工具 + 声明式统计面板（无任何文件/网络 I/O）。
// 修改此文件后重启启动器生效。
let stats = { count: 0, max: 0, total: 0 }

function roll(sides) {
  return 1 + Math.floor(Math.random() * sides)
}

function doRoll(sides) {
  stats.count++
  const r = roll(sides)
  if (r > stats.max) stats.max = r
  stats.total += r
  return r
}

export async function activate(ctx) {
  const mount = () => {
    ctx.capabilities['ui.panel'].mountPanel(
      {
        title: '骰子统计',
        items: [
          { type: 'text', content: '共掷 ' + stats.count + ' 次' },
          {
            type: 'kv',
            rows: {
              最大: String(stats.max || '-'),
              平均: stats.count > 0 ? (stats.total / stats.count).toFixed(1) : '-'
            }
          },
          { type: 'button', label: '再掷一次', action: 'roll' }
        ]
      },
      async function (action) {
        if (action === 'roll') doRoll(6)
        await mount()
      }
    )
  }
  mount()

  ctx.capabilities['ai.tools'].registerTool({
    name: 'dice_roll',
    description: '掷骰子。参数：sides（面数，默认 6，最大 1000）、count（次数，默认 1，最大 10）。',
    parameters: {
      type: 'object',
      properties: {
        sides: { type: 'number', description: '面数，如 20 表示 d20' },
        count: { type: 'number', description: '掷几次' }
      }
    },
    handler(args) {
      const sides = typeof args.sides === 'number' && args.sides > 1 ? Math.floor(args.sides) : 6
      const count = typeof args.count === 'number' && args.count > 0 ? Math.min(Math.floor(args.count), 10) : 1
      const rolls = []
      for (let i = 0; i < count; i++) rolls.push(doRoll(sides))
      return JSON.stringify({ rolls: rolls, total: rolls.reduce(function (a, b) { return a + b }, 0) })
    }
  })
}
`
}
