// The runs the owner starts from My Work (answers, stages, the focus plan), from the snapshot to the model. Kept apart
// from to-work-model so both of its callers (the worker's overview and the page's own mapping of a full snapshot) add
// the same fields. Pure, so `node --test` can load it.
import type { FocusChange, FocusPlan, FocusPlanSummary, PlanProposal, Request, RequestStage } from '../data.ts'
import type { MappedWorkModel } from './work-data-source.ts'
import { fileUnderInitiative } from './thread-groups.ts'
import type { WorkViewHumanRequest, WorkViewSnapshot } from './work-view-api-types.ts'

/**
 * Whether the work has moved past a ready stage: the request has a later review than the one the stage was made for,
 * or one of its records (an ask, a work item) is newer than the stage itself.
 */
function stageIsOutdated(stage: Pick<RequestStage, 'state' | 'generatedAt' | 'reviewedThrough'>, raw: Partial<Pick<WorkViewHumanRequest, 'progress' | 'updatedAtEpoch'>>): boolean {
  if (stage.state !== 'ready') return false
  const reviewedThrough = Date.parse(raw.progress?.reviewedThrough ?? '')
  if (Number.isFinite(reviewedThrough) && !(Date.parse(stage.reviewedThrough ?? '') >= reviewedThrough)) return true
  const writtenAt = Date.parse(stage.generatedAt ?? '')
  return Number.isFinite(writtenAt) && (raw.updatedAtEpoch ?? 0) > writtenAt
}

/** A request's stages, newest first, and the answer last sent to it. Absent keys for a request with neither. */
export function requestRunFields(raw: Pick<WorkViewHumanRequest, 'stages' | 'answer'> & Partial<Pick<WorkViewHumanRequest, 'progress' | 'updatedAtEpoch'>>): Pick<Request, 'stages' | 'readyStages' | 'answer'> {
  const stages: RequestStage[] = Object.entries(raw.stages ?? {}).map(([formatId, stage]) => ({
    formatId, state: stage.state, ...(stage.state === 'ready' && stage.url ? { href: stage.url } : {}),
    startedAt: stage.startedAt, generatedAt: stage.generatedAt, reviewedThrough: stage.reviewedThrough, error: stage.error, trigger: stage.trigger,
    outdated: stageIsOutdated(stage, raw),
  })).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const ready = stages.filter((stage) => stage.state === 'ready').map((stage) => stage.formatId)
  return {
    ...(stages.length ? { stages } : {}),
    ...(ready.length ? { readyStages: ready } : {}),
    ...(raw.answer ? { answer: { state: raw.answer.state, ...(raw.answer.error ? { error: raw.answer.error } : {}) } } : {}),
  }
}

export const focusPlanSummary = (plan: FocusPlan | FocusPlanSummary): FocusPlanSummary => ({
  state: plan.state, focusAreaId: plan.focusAreaId, startedAt: plan.startedAt, generatedAt: plan.generatedAt, error: plan.error,
  proposals: typeof plan.proposals === 'number' ? plan.proposals : plan.proposals.length,
})

/** The mapped model with what the snapshot says about owner runs: per request, and the formats, the automatic choice and the plan. */
export function withOwnerRuns<Model extends MappedWorkModel>(model: Model, snapshot: Pick<WorkViewSnapshot, 'humanRequests' | 'stageFormats' | 'autoStageFormat' | 'focusPlan'>): Model {
  const rawById = new Map(snapshot.humanRequests.map((raw) => [raw.id, raw]))
  return {
    ...model,
    requests: model.requests.map((request) => {
      const raw = rawById.get(request.id)
      return raw?.stages || raw?.answer ? { ...request, ...requestRunFields(raw) } : request
    }),
    ...(snapshot.stageFormats ? { stageFormats: snapshot.stageFormats } : {}),
    ...(snapshot.autoStageFormat !== undefined ? { autoStageFormat: snapshot.autoStageFormat } : {}),
    ...(snapshot.focusPlan !== undefined ? { focusPlan: snapshot.focusPlan ? focusPlanSummary(snapshot.focusPlan) : null } : {}),
  }
}

/**
 * The owner's own action that applies one accepted proposal: reorder, set-initiative, edit-goal or edit-notes, saved like any other
 * focus change. Null for next asks: they are asks to copy into a chat, and nothing applies them.
 */
export function planProposalChange(proposal: PlanProposal): FocusChange | null {
  if (proposal.kind === 'reorder') return { action: 'reorder', focusAreaIds: proposal.focusAreaIds }
  if (proposal.kind === 'initiative') return fileUnderInitiative(proposal.focusAreaIds, proposal.initiative)
  if (proposal.kind === 'goal') return { action: 'edit-goal', focusAreaId: proposal.focusAreaId, goal: proposal.goal }
  if (proposal.kind === 'notes') return { action: 'edit-notes', focusAreaId: proposal.focusAreaId, notes: proposal.notes }
  return null
}
