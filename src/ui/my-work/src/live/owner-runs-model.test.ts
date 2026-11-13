// Owner runs from the snapshot to the model: a request's stages and answer, the formats, the plan's summary, and the
// focus change that applies one accepted proposal.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { planProposalChange, requestRunFields, withOwnerRuns } from './owner-runs-model.ts'
import { toWorkModel } from './to-work-model.ts'
import type { WorkViewSnapshot } from './work-view-api-types.ts'
import type { FocusPlan } from '../data.ts'
import { ANSWER_RUN_STATES, PLAN_PROPOSAL_KINDS, STAGE_STATES } from '../../../../services/work-view/owner-runs.mjs'

const snapshot = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as WorkViewSnapshot
const stage = (state: (typeof STAGE_STATES)[number], startedAt: string, change = {}) => ({
  state, file: state === 'ready' ? '/bucket/stage.md' : null, url: state === 'ready' ? '/api/deliverables/9/stage.md' : null, startedAt,
  generatedAt: state === 'ready' ? startedAt : null, reviewedThrough: '2026-11-10T10:00:00.000Z', error: state === 'failed' ? 'Claude Code: quota' : null, pid: 1, trigger: 'owner' as const, ...change,
})

test('a request\'s stages are listed newest first, only ready ones open, and the answer keeps its failure', () => {
  const fields = requestRunFields({
    stages: { brief: stage('ready', '2026-11-11T09:00:00.000Z'), deck: stage('failed', '2026-11-11T10:00:00.000Z'), technical: stage('generating', '2026-11-11T11:00:00.000Z', { trigger: 'auto' }) },
    answer: { state: 'failed', token: 't', platform: 'claude', startedAt: 'x', finishedAt: 'y', error: 'The tool exited 1', pid: 1 },
  })
  assert.deepEqual(fields.stages!.map((entry) => [entry.formatId, entry.state, entry.href, entry.error, entry.trigger]), [
    ['technical', 'generating', undefined, null, 'auto'], ['deck', 'failed', undefined, 'Claude Code: quota', 'owner'], ['brief', 'ready', '/api/deliverables/9/stage.md', null, 'owner'],
  ])
  assert.deepEqual(fields.readyStages, ['brief'])
  assert.deepEqual(fields.answer, { state: 'failed', error: 'The tool exited 1' })
  assert.deepEqual(requestRunFields({}), {})
  for (const state of ANSWER_RUN_STATES) assert.equal(requestRunFields({ answer: { state, token: 't', platform: 'codex', startedAt: 'x', finishedAt: null, error: null, pid: 1 } }).answer!.state, state)
})

test('a ready stage is outdated once the request was reviewed again or its records moved after the stage was written', () => {
  const made = '2026-11-11T09:00:00.000Z', madeAt = Date.parse(made)
  const review = (reviewedThrough: string) => ({ state: 'in-progress' as const, percent: 90, checkedAt: reviewedThrough, reviewedThrough })
  const outdated = (raw: Parameters<typeof requestRunFields>[0]) => requestRunFields(raw).stages!.map((entry) => entry.outdated)
  const stages = { brief: stage('ready', made) }
  // Made for the request's current review, and nothing recorded since.
  assert.deepEqual(outdated({ stages, progress: review('2026-11-10T10:00:00.000Z'), updatedAtEpoch: madeAt - 1000 }), [false])
  assert.deepEqual(outdated({ stages, progress: review('2026-11-10T10:00:00.000Z'), updatedAtEpoch: madeAt }), [false])
  // An older worker's snapshot says neither: nothing is called outdated on a guess.
  assert.deepEqual(outdated({ stages }), [false])
  // A later review than the one it was made for.
  assert.deepEqual(outdated({ stages, progress: review('2026-11-11T12:00:00.000Z'), updatedAtEpoch: madeAt - 1000 }), [true])
  assert.deepEqual(outdated({ stages: { brief: stage('ready', made, { reviewedThrough: null }) }, progress: review('2026-11-10T10:00:00.000Z') }), [true])
  // A new ask or work item after the stage was written, before any review of it.
  assert.deepEqual(outdated({ stages, progress: review('2026-11-10T10:00:00.000Z'), updatedAtEpoch: madeAt + 1000 }), [true])
  // Only a stage that can be read is ever outdated.
  assert.deepEqual(outdated({ stages: { brief: stage('generating', made), deck: stage('failed', made) }, progress: review('2026-11-11T12:00:00.000Z'), updatedAtEpoch: madeAt + 1000 }), [false, false])
})

test('the model carries what the snapshot says about owner runs, and an older worker\'s snapshot adds nothing', () => {
  const plain = toWorkModel(snapshot, Date.parse(snapshot.generatedAt))
  assert.deepEqual(withOwnerRuns(plain, snapshot), plain)
  const plan: FocusPlan & { token: string; pid: number } = { state: 'ready', focusAreaId: null, token: 't', pid: 1, startedAt: 'a', generatedAt: 'b', error: null, skipped: [], proposals: [{ kind: 'goal', focusAreaId: 'fa', goal: 'g', reason: 'r' }] }
  const [first, ...rest] = snapshot.humanRequests
  const model = withOwnerRuns(plain, {
    humanRequests: [{ ...first, stages: { brief: stage('ready', '2026-11-11T09:00:00.000Z') } }, ...rest],
    stageFormats: [{ id: 'brief', label: 'Brief', output: 'markdown', builtIn: true }], autoStageFormat: null, focusPlan: plan,
  })
  assert.deepEqual(model.requests.find((request) => request.id === first.id)!.readyStages, ['brief'])
  assert.deepEqual(model.stageFormats, [{ id: 'brief', label: 'Brief', output: 'markdown', builtIn: true }])
  assert.equal(model.autoStageFormat, null)
  assert.deepEqual(model.focusPlan, { state: 'ready', focusAreaId: null, startedAt: 'a', generatedAt: 'b', error: null, proposals: 1 })
})

test('an accepted proposal is saved by the owner\'s own focus action; next asks apply nothing', () => {
  assert.deepEqual(planProposalChange({ kind: 'reorder', focusAreaIds: ['b', 'a'], moves: [] }), { action: 'reorder', focusAreaIds: ['b', 'a'] })
  assert.deepEqual(planProposalChange({ kind: 'goal', focusAreaId: 'a', goal: 'Sharper.', reason: 'r' }), { action: 'edit-goal', focusAreaId: 'a', goal: 'Sharper.' })
  assert.deepEqual(planProposalChange({ kind: 'notes', focusAreaId: 'a', notes: 'Why.', draft: true, quotes: ['q'] }), { action: 'edit-notes', focusAreaId: 'a', notes: 'Why.' })
  assert.equal(planProposalChange({ kind: 'next-asks', focusAreaId: 'a', asks: [] }), null)
  assert.deepEqual(planProposalChange({ kind: 'initiative', initiative: 'Kite maps', focusAreaIds: ['a', 'b'], reason: 'r' }), { action: 'set-initiative', focusAreaIds: ['a', 'b'], initiative: 'Kite maps' })
  assert.deepEqual([...PLAN_PROPOSAL_KINDS], ['reorder', 'initiative', 'goal', 'notes', 'next-asks'])
})
