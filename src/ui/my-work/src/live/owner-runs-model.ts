// The runs the owner starts from My Work (answers, stages, the focus plan), from the snapshot to what the page shows.
// Pure, so `node --test` can load it.
import type { FocusChange, FocusPlan, FocusPlanSummary, PlanProposal, Request, RequestStage } from '../data.ts'
import type { WorkViewHumanRequest } from './work-view-api-types.ts'

/**
 * A request's stages, newest first. A ready stage made for an earlier review than the request's current one is
 * `outdated`: the work moved on after it was written, so the page says so beside its link.
 */
export function requestStages(raw: Pick<WorkViewHumanRequest, 'stages' | 'progress'>): RequestStage[] {
  const reviewedThrough = Date.parse(raw.progress?.reviewedThrough ?? '')
  return Object.entries(raw.stages ?? {})
    .sort(([, a], [, b]) => b.startedAt.localeCompare(a.startedAt))
    .map(([formatId, stage]) => ({
      formatId, state: stage.state, ...(stage.state === 'ready' && stage.url ? { href: stage.url } : {}), error: stage.error,
      outdated: stage.state === 'ready' && Number.isFinite(reviewedThrough) && !(Date.parse(stage.reviewedThrough ?? '') >= reviewedThrough),
    }))
}

/** A stage reviews finished work: the list shows on a request that waits for a check, shipped, was checked, or already has a stage. */
export const offersStages = (request: Pick<Request, 'state' | 'checkedAt' | 'stages'>): boolean =>
  !!request.stages?.length || request.state === 'needs-check' || request.state === 'shipped' || !!request.checkedAt

export const focusPlanSummary = (plan: FocusPlan): FocusPlanSummary => ({
  state: plan.state, focusAreaId: plan.focusAreaId, startedAt: plan.startedAt, generatedAt: plan.generatedAt, error: plan.error, proposals: plan.proposals.length,
})

/**
 * What the request page shows about answering. The question and the last delivery are separate facts: a delivery that
 * is still on its way, or that failed, shows whether or not another answer is needed. `sentText` is the answer this
 * page sent, kept until it is delivered so a failed one can be copied.
 */
export function answerPanel(request: Pick<Request, 'question' | 'answer'>, sentText: string | undefined): { question: NonNullable<Request['question']> | null; delivery: (NonNullable<Request['answer']> & { text?: string }) | null } {
  const { answer } = request
  return {
    question: request.question ?? null,
    delivery: answer ? { ...answer, ...(sentText && answer.state !== 'delivered' ? { text: sentText } : {}) } : null,
  }
}

/**
 * The owner's own action that applies one accepted proposal: reorder or edit-goal, saved like any other focus change.
 * Null for next asks: they are asks to copy into a chat, and nothing applies them.
 */
export function planProposalChange(proposal: PlanProposal): FocusChange | null {
  if (proposal.kind === 'reorder') return { action: 'reorder', focusAreaIds: proposal.focusAreaIds }
  if (proposal.kind === 'goal') return { action: 'edit-goal', focusAreaId: proposal.focusAreaId, goal: proposal.goal }
  return null
}
