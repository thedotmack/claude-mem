import type { OwnerRule, RuleDraft, RuleScope } from '../data-rules.ts'

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

/** New workers identify the saved row. Older workers need a unique matching addition, never the first new row. */
export function addedRuleFromSave(saved: { rules: OwnerRule[]; ruleScopes: RuleScope[] }, previous: OwnerRule[], draft: RuleDraft, savedRuleId?: string): OwnerRule | undefined {
  if (savedRuleId) return saved.rules.find((rule) => rule.id === savedRuleId)
  const previousIds = new Set(previous.map((rule) => rule.id))
  const matches = saved.rules.filter((rule) => {
    if (previousIds.has(rule.id) || rule.setBy !== 'owner' || rule.when !== draft.when || rule.then !== draft.then) return false
    const scope = saved.ruleScopes.find((scope) => scope.id === rule.scopeId)
    return scope?.tier === draft.scopeTier && (draft.scopeTier === 'everywhere' || scope.name === draft.scopeName)
  })
  return matches.length === 1 ? matches[0] : undefined
}
