// My Rules' decision queue (c-rules-decision-queue): which waiting rule the full card shows, and in what order the rest
// follow. Pure, so `node --test` can load it.
import type { OwnerRule } from '../data-rules.ts'
import type { RuleDecision } from './rule-actions.ts'

/**
 * The queue in the order the person first saw it, as rule ids, so a live update never reorders the rows under the
 * reader. `seen` is the order kept so far, rules that have left the list since included (their places say what came
 * after them). The first draw takes the list's own order (strongest first); a rule new to the queue joins right after
 * `currentId`, the rule the card shows, so a stronger new suggestion lands in "Up next" and never takes the card.
 * Returns `seen` itself when nothing is new.
 */
export function keepShownOrder(seen: readonly string[], sorted: readonly OwnerRule[], currentId: string | null): readonly string[] {
  const known = new Set(seen)
  const fresh = sorted.filter((rule) => !known.has(rule.id)).map((rule) => rule.id)
  if (fresh.length === 0) return seen
  const at = currentId === null ? -1 : seen.indexOf(currentId)
  if (at < 0) return [...seen, ...fresh]
  return [...seen.slice(0, at + 1), ...fresh, ...seen.slice(at + 1)]
}

/** The rules of `list` in the shown order; `order` comes from keepShownOrder over the same rules. */
export function inShownOrder(order: readonly string[], list: readonly OwnerRule[]): OwnerRule[] {
  const byId = new Map(list.map((rule) => [rule.id, rule]))
  return order.flatMap((id) => byId.get(id) ?? [])
}

/**
 * The rule the queue shows in full (quality M1): the pointer's rule while it waits; else the next waiting rule after
 * it in the shown order, wrapping, also when the pointer's rule has left the list (decided on another computer), so
 * the card moves to the rule after it, not back to the first; with no pointer yet, the first waiting rule.
 */
export function currentIn(order: readonly string[], list: readonly OwnerRule[], decisions: Readonly<Record<string, RuleDecision>>, pointer: string | null): OwnerRule | null {
  const listed = new Map(list.map((rule) => [rule.id, rule]))
  const waiting = (id: string) => listed.has(id) && !decisions[id]
  const at = pointer === null ? -1 : order.indexOf(pointer)
  if (pointer !== null && waiting(pointer)) return listed.get(pointer)!
  if (at < 0) return list.find((rule) => !decisions[rule.id]) ?? null
  for (let moved = 1; moved < order.length; moved++) {
    const id = order[(at + moved) % order.length]
    if (waiting(id)) return listed.get(id)!
  }
  return null
}

/** The waiting rule `step` places from `from` in `list` (wrapping), skipping decided ones; null when none other waits. */
export function stepFrom(list: readonly OwnerRule[], decisions: Readonly<Record<string, RuleDecision>>, from: OwnerRule, step: 1 | -1): OwnerRule | null {
  const at = list.indexOf(from)
  for (let moved = 1; moved < list.length; moved++) {
    const rule = list[(at + step * moved + list.length * moved) % list.length]
    if (!decisions[rule.id]) return rule
  }
  return null
}

/** Up to `count` waiting rules after `current` in `list`, wrapping: the "Up next" rows. */
export function upNextAfter(list: readonly OwnerRule[], decisions: Readonly<Record<string, RuleDecision>>, current: OwnerRule | null, count: number): OwnerRule[] {
  const rows: OwnerRule[] = []
  for (let next = current; next && rows.length < count;) {
    next = stepFrom(list, decisions, next, 1)
    if (!next || next === current || rows.includes(next)) break
    rows.push(next)
  }
  return rows
}
