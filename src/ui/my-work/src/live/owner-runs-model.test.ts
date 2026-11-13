// Owner runs from the snapshot to the page: a request's stages, the answer panel, and the focus change that applies
// one accepted proposal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerPanel, focusPlanSummary, offersStages, planProposalChange, requestStages } from './owner-runs-model.ts'
import { ANSWER_RUN_STATES, PLAN_PROPOSAL_KINDS, type StageRecord, type StageState } from '../../../../services/work-view/owner-runs.mjs'

const stage = (state: StageState, startedAt: string, change: Partial<StageRecord> = {}): StageRecord => ({
  state, file: state === 'ready' ? '/bucket/stage.md' : null, url: state === 'ready' ? '/api/deliverables/9/stage.md' : null, startedAt,
  generatedAt: state === 'ready' ? startedAt : null, reviewedThrough: '2026-11-10T10:00:00.000Z', error: state === 'failed' ? 'Claude Code: quota' : null, pid: 1, trigger: 'owner', ...change,
})
const review = (reviewedThrough: string | undefined) => ({ state: 'in-progress' as const, percent: 100, ...(reviewedThrough ? { reviewedThrough } : {}) })

test('a request\'s stages are listed newest first, and only a ready one opens', () => {
  const stages = requestStages({
    stages: { brief: stage('ready', '2026-11-11T09:00:00.000Z'), 'one-pager': stage('failed', '2026-11-11T10:00:00.000Z'), technical: stage('generating', '2026-11-11T11:00:00.000Z', { trigger: 'auto' }) },
    progress: review('2026-11-10T10:00:00.000Z'),
  })
  assert.deepEqual(stages, [
    { formatId: 'technical', state: 'generating', error: null, outdated: false },
    { formatId: 'one-pager', state: 'failed', error: 'Claude Code: quota', outdated: false },
    { formatId: 'brief', state: 'ready', href: '/api/deliverables/9/stage.md', error: null, outdated: false },
  ])
  assert.deepEqual(requestStages({}), [])
})

test('a ready stage made for an earlier review than the request\'s current one is out of date', () => {
  const made = { brief: stage('ready', '2026-11-11T09:00:00.000Z') }
  const outdated = (progress: ReturnType<typeof review> | null) => requestStages({ stages: made, progress })[0].outdated
  assert.equal(outdated(review('2026-11-10T10:00:00.000Z')), false, 'the review it was made for')
  assert.equal(outdated(review('2026-11-12T08:00:00.000Z')), true, 'new work was reviewed after it was written')
  assert.equal(outdated(review(undefined)), false, 'a review from a worker that records no read time says nothing')
  assert.equal(outdated(null), false)
  // Made before any review existed: the first review is newer than it.
  assert.equal(requestStages({ stages: { brief: stage('ready', '2026-11-11T09:00:00.000Z', { reviewedThrough: null }) }, progress: review('2026-11-12T08:00:00.000Z') })[0].outdated, true)
  // Only a document that can be opened can be out of date.
  assert.equal(requestStages({ stages: { brief: stage('failed', '2026-11-11T09:00:00.000Z') }, progress: review('2026-11-12T08:00:00.000Z') })[0].outdated, false)
})

test('the stage list shows on finished work and wherever a stage already exists', () => {
  assert.equal(offersStages({ state: 'needs-check' }), true)
  assert.equal(offersStages({ state: 'shipped' }), true)
  assert.equal(offersStages({ state: 'your-move', checkedAt: 'Nov 12' }), true)
  assert.equal(offersStages({ state: 'working', stages: [{ formatId: 'brief', state: 'failed', error: 'quota', outdated: false }] }), true)
  assert.equal(offersStages({ state: 'working' }), false)
  assert.equal(offersStages({ state: 'your-move' }), false)
})

const QUESTION = { need: 'answer' as const, text: 'Linear or seasonal?', version: '2026-11-10T10:00:00.000Z', background: ['Linear matched within 4%.'] }

test('a delivery shows whether or not another answer is needed', () => {
  // The agent took the question away, and the tool then failed: the failure still shows, with the answer to copy.
  assert.deepEqual(answerPanel({ answer: { state: 'failed', error: 'The tool exited 1' } }, 'Keep linear.'),
    { question: null, delivery: { state: 'failed', error: 'The tool exited 1', text: 'Keep linear.' } })
  assert.deepEqual(answerPanel({ answer: { state: 'answering' } }, 'Keep linear.'), { question: null, delivery: { state: 'answering', text: 'Keep linear.' } })
  for (const state of ANSWER_RUN_STATES) assert.equal(answerPanel({ answer: { state } }, undefined).delivery!.state, state)
})

test('a question and the last delivery show together, and a delivered answer keeps no text', () => {
  assert.deepEqual(answerPanel({ question: QUESTION, answer: { state: 'delivered' } }, 'Keep linear.'), { question: QUESTION, delivery: { state: 'delivered' } })
  assert.deepEqual(answerPanel({ question: QUESTION }, undefined), { question: QUESTION, delivery: null })
  assert.deepEqual(answerPanel({}, 'left over'), { question: null, delivery: null })
})

test('an accepted proposal is saved by the owner\'s own focus action; next asks apply nothing', () => {
  assert.deepEqual(planProposalChange({ kind: 'reorder', focusAreaIds: ['b', 'a'], moves: [] }), { action: 'reorder', focusAreaIds: ['b', 'a'] })
  assert.deepEqual(planProposalChange({ kind: 'goal', focusAreaId: 'a', goal: 'Sharper.', reason: 'r' }), { action: 'edit-goal', focusAreaId: 'a', goal: 'Sharper.' })
  assert.equal(planProposalChange({ kind: 'next-asks', focusAreaId: 'a', asks: [] }), null)
  assert.deepEqual([...PLAN_PROPOSAL_KINDS], ['reorder', 'goal', 'next-asks'])
})

test('the model carries a plan without its proposals', () => {
  assert.deepEqual(focusPlanSummary({ state: 'ready', focusAreaId: null, startedAt: 'a', generatedAt: 'b', error: null, skipped: ['x'], proposals: [{ kind: 'goal', focusAreaId: 'fa', goal: 'g', reason: 'r' }] }),
    { state: 'ready', focusAreaId: null, startedAt: 'a', generatedAt: 'b', error: null, proposals: 1 })
})
