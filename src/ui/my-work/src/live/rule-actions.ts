import type { OwnerRule } from '../data-rules.ts'

export type RuleDecision = 'approved' | 'rejected'
export interface SavedRuleDecision { decision: RuleDecision; version: string }

/** Ignore display clocks, but invalidate local receipts when saved rule content changes. */
export function ruleVersion(rule: OwnerRule | undefined): string | null {
  if (!rule) return null
  const { latestAt: _latest, latestDaysAgo: _age, quotes, records, replacedBy, ...record } = rule
  return JSON.stringify({
    ...record,
    quotes: quotes.map(({ at: _at, ...quote }) => quote),
    records: records.map(({ at: _at, ...source }) => source),
    replacedBy: replacedBy?.ruleId ?? null,
  })
}

/** A previous local decision is only a receipt for the exact version the worker saved. */
export function currentRuleDecisions(rules: OwnerRule[], saved: Record<string, SavedRuleDecision>): Record<string, RuleDecision> {
  const current: Record<string, RuleDecision> = {}
  for (const rule of rules) {
    const receipt = saved[rule.id]
    if (!receipt || receipt.version !== ruleVersion(rule)) continue
    if (receipt.decision === 'approved' && rule.status === 'on' && rule.setBy !== 'learned') current[rule.id] = 'approved'
    if (receipt.decision === 'rejected' && rule.status === 'dismissed') current[rule.id] = 'rejected'
  }
  return current
}

export function ruleUndoIsCurrent(ruleId: string, expectedVersion: string | null, rules: OwnerRule[]): boolean {
  return expectedVersion !== null && expectedVersion === ruleVersion(rules.find((rule) => rule.id === ruleId))
}
