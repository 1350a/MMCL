/**
 * 版本隔离策略（UI-DESIGN.md §3）：隔离本质 = 启动时给游戏传的 gameDir 指向。
 * 开 → 版本文件夹；关 → 根 .minecraft。saves/screenshots/options/logs/mods/config
 * 跟 gameDir 走；assets/libraries/版本本体由启动器从根传参注入、永远共享。
 */

/** 五档策略（设置页单选下拉；每版本可选「跟随全局」覆盖）。 */
export type IsolationStrategy = 'all' | 'none' | 'snapshotOnly' | 'modOnly' | 'snapshotAndMod'

export const ISOLATION_STRATEGIES: readonly IsolationStrategy[] = ['all', 'none', 'snapshotOnly', 'modOnly', 'snapshotAndMod']

export function isIsolationStrategy(v: unknown): v is IsolationStrategy {
  return typeof v === 'string' && (ISOLATION_STRATEGIES as readonly string[]).includes(v)
}

/** 判定材料：版本类型（snapshot/release）+ 是否装加载器。 */
export interface IsolationFacts {
  isSnapshot: boolean
  isMod: boolean
}

/**
 * 策略是否覆盖该类版本（§3 矩阵）：
 * 全部开启=全隔离；全部关闭=不隔离；仅隔离快照版=快照类（含 mod 版快照本体）；
 * 仅隔离 mod 版=装了加载器的版本；隔离快照版和 mod 版=两者之一即隔离。
 */
export function strategyCovers(strategy: IsolationStrategy, facts: IsolationFacts): boolean {
  switch (strategy) {
    case 'all':
      return true
    case 'none':
      return false
    case 'snapshotOnly':
      return facts.isSnapshot
    case 'modOnly':
      return facts.isMod
    case 'snapshotAndMod':
      return facts.isSnapshot || facts.isMod
  }
}

/**
 * 解析有效隔离（单版本）：
 * 每版本 isolation 缺省/'follow' → 用全局策略；否则按每版本覆盖值判定。
 */
export function resolveIsolation(options: {
  perVersion?: IsolationStrategy | 'follow'
  globalStrategy: IsolationStrategy
  isSnapshot: boolean
  isMod: boolean
}): boolean {
  const strategy = !options.perVersion || options.perVersion === 'follow' ? options.globalStrategy : options.perVersion
  return strategyCovers(strategy, { isSnapshot: options.isSnapshot, isMod: options.isMod })
}
