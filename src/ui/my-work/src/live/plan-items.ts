// A focus plan's proposals as the lines the page lists: grouped by kind, each with its reasoning and the owner's own
// action that would apply it. Pure, so `node --test` can load it.
import type { FocusArea, FocusChange, FocusPlan } from '../data.ts'
import { PLAN_PROPOSAL_KINDS, type PlanProposalKind } from '../../../../services/work-view/owner-runs.mjs'
import { planProposalChange } from './owner-runs-model.ts'

export interface PlanItem {
  key: string
  kind: PlanProposalKind
  /** The area it is about; null for the order of all of them. */
  areaName: string | null
  text: string
  reasons: string[]
  /** What Accept saves. Null for a next ask: it is copied into a chat, and nothing applies it. */
  change: FocusChange | null
}

export function planItems(plan: Pick<FocusPlan, 'proposals'>, areas: readonly Pick<FocusArea, 'id' | 'name'>[]): PlanItem[] {
  const nameOf = (id: string) => areas.find((area) => area.id === id)?.name ?? id
  const items = plan.proposals.flatMap((proposal, index): PlanItem[] => {
    const key = `${proposal.kind}:${index}`
    const change = planProposalChange(proposal)
    if (proposal.kind === 'reorder') return [{ key, kind: proposal.kind, areaName: null, text: proposal.focusAreaIds.map(nameOf).join(' → '), reasons: proposal.moves.map((move) => `${nameOf(move.focusAreaId)}: ${move.reason}`), change }]
    const areaName = nameOf(proposal.focusAreaId)
    if (proposal.kind === 'goal') return [{ key, kind: proposal.kind, areaName, text: proposal.goal, reasons: [proposal.reason], change }]
    return proposal.asks.map((ask, askIndex) => ({ key: `${key}:${askIndex}`, kind: proposal.kind, areaName, text: ask.text, reasons: [ask.reason], change: null }))
  })
  return items.sort((a, b) => PLAN_PROPOSAL_KINDS.indexOf(a.kind) - PLAN_PROPOSAL_KINDS.indexOf(b.kind))
}
