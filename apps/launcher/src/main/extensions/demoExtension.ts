/** M5-2 演示：在 QuickJS 沙箱内运行的示例扩展源码（纯计算工具 dice_roll，无任何 I/O）。 */
export const DEMO_EXTENSION_CODE = `globalThis.__MCL_ENTRY__ = {
  activate(ctx) {
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
        for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(Math.random() * sides))
        return JSON.stringify({ rolls: rolls, total: rolls.reduce(function (a, b) { return a + b }, 0) })
      }
    })
  }
}`
