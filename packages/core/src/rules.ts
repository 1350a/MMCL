import type { Rule, RuleOs } from './version'

/** 规则评估上下文：当前平台与启用特性。 */
export interface RuleContext {
  os: { name: string; version?: string; arch: string }
  /** 已启用的特性（如 has_custom_resolution），未启用的特性取 undefined。 */
  features: Record<string, boolean>
}

function matchOs(os: RuleOs, ctx: RuleContext): boolean {
  if (os.name !== undefined && os.name !== ctx.os.name) return false
  if (os.arch !== undefined && os.arch !== ctx.os.arch) return false
  if (os.version !== undefined) {
    // os.version 是正则（如 "^10\\."），不匹配则失败
    if (!new RegExp(os.version).test(ctx.os.version ?? '')) return false
  }
  return true
}

/**
 * 评估单条规则是否匹配当前上下文。
 * 无 os 与 features 条件时恒匹配；features 要求全部启用（值相等）。
 */
function matchRule(rule: Rule, ctx: RuleContext): boolean {
  if (rule.os !== undefined && !matchOs(rule.os, ctx)) return false
  if (rule.features !== undefined) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if (ctx.features[key] !== expected) return false
    }
  }
  return true
}

/**
 * 评估规则列表：按顺序逐条评估，取最后一条匹配规则的动作；
 * 有 rules 但无匹配时默认不允许（官方语义：osx-only 规则必须能排除其他平台）。
 * 无 rules 字段直接允许。
 */
export function evaluateRules(rules: Rule[] | undefined, ctx: RuleContext): boolean {
  if (rules === undefined || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (matchRule(rule, ctx)) {
      allowed = rule.action === 'allow'
    }
  }
  return allowed
}
