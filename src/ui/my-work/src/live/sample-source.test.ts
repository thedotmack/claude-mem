// The sample plays every one-click run without an agent or a worker, in the states the worker would report.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sampleSource, setSampleRunDelay } from './sample-source.ts'
import { planProposalChange } from './owner-runs-model.ts'
import type { WorkModel } from './work-data-source.ts'

setSampleRunDelay(5)
const shown: WorkModel[] = []
sampleSource.subscribeToLiveUpdates((model) => { shown.push(model) }, () => {})
const request = async (id: string) => (await sampleSource.loadWorkModel()).requests.find((entry) => entry.id === id)!
const played = () => new Promise((resolve) => setTimeout(resolve, 30))

test('an answer is sent, then delivered, and the question it answered no longer stands', async () => {
  assert.ok((await request('r4')).question)
  assert.deepEqual(await sampleSource.answerRequest!('r4', 'Yes, publish them.', 'sample-click-1'), { outcome: 'started' })
  assert.deepEqual((await request('r4')).answer, { state: 'answering' })
  assert.deepEqual(await sampleSource.answerRequest!('r4', 'Yes, publish them.', 'sample-click-1'), { outcome: 'duplicate' })
  await assert.rejects(sampleSource.answerRequest!('r4', 'Again.', 'sample-click-2'), /still being delivered/)
  await played()
  const after = await request('r4')
  assert.deepEqual(after.answer, { state: 'delivered' })
  assert.equal(after.question, undefined)
  assert.deepEqual(shown.at(-1)!.requests.find((entry) => entry.id === 'r4')!.answer, { state: 'delivered' })
})

test('a failed delivery says why and keeps the question; a tool that cannot be resumed refuses and sends nothing', async () => {
  assert.deepEqual(await sampleSource.answerRequest!('r1', 'Open on the suggestions.', 'sample-click-3'), { outcome: 'started' })
  await played()
  const failed = await request('r1')
  assert.equal(failed.answer!.state, 'failed')
  assert.match(failed.answer!.error!, /session limit/)
  assert.ok(failed.question)
  const refused = await sampleSource.answerRequest!('r5', 'Linear.', 'sample-click-4')
  assert.equal(refused.outcome, 'refused')
  assert.equal((await request('r5')).answer, undefined)
})

test('a stage is made, then ready, beside the sample\'s failed and outdated ones', async () => {
  const model = await sampleSource.loadWorkModel()
  assert.deepEqual(model.stageFormats!.map((format) => format.id), ['brief', 'one-pager', 'technical'])
  assert.deepEqual((await request('r3')).stages!.map((stage) => [stage.formatId, stage.state, stage.outdated]), [['one-pager', 'ready', true], ['technical', 'failed', false]])
  assert.deepEqual(await sampleSource.generateStage!('r3', 'brief', 'sample-click-5'), { outcome: 'started' })
  assert.equal((await request('r3')).stages![0].state, 'generating')
  await assert.rejects(sampleSource.generateStage!('r3', 'brief', 'sample-click-6'), /already being made/)
  await assert.rejects(sampleSource.generateStage!('r3', 'deck', 'sample-click-7'), /does not exist/)
  await played()
  assert.deepEqual((await request('r3')).stages![0], { formatId: 'brief', state: 'ready', href: '#', error: null, outdated: false })
})

test('automatic stages are off until chosen, and choosing makes nothing', async () => {
  assert.equal((await sampleSource.loadWorkModel()).autoStageFormat, null)
  const before = (await request('r4')).stages
  assert.equal((await sampleSource.setAutoStageFormat!('brief')).autoStageFormat, 'brief')
  assert.equal((await request('r4')).stages, before)
  assert.equal((await sampleSource.setAutoStageFormat!(null)).autoStageFormat, null)
})

test('a plan is planned, then ready with suggestions the owner\'s own actions can save, and applies none', async () => {
  const areasBefore = JSON.stringify((await sampleSource.loadWorkModel()).focusAreas)
  assert.deepEqual(await sampleSource.planFocus!(null, 'sample-click-8'), { outcome: 'started' })
  assert.equal((await sampleSource.loadWorkModel()).focusPlan!.state, 'planning')
  await assert.rejects(sampleSource.planFocus!(null, 'sample-click-9'), /already being made/)
  await played()
  const plan = (await sampleSource.loadFocusPlan!())!
  assert.equal(plan.state, 'ready')
  assert.deepEqual([...new Set(plan.proposals.map((proposal) => proposal.kind))], ['reorder', 'goal', 'next-asks'])
  assert.equal((await sampleSource.loadWorkModel()).focusPlan!.proposals, plan.proposals.length)
  assert.equal(JSON.stringify((await sampleSource.loadWorkModel()).focusAreas), areasBefore)
  // Accept is the owner's ordinary focus change: the sample saves it like any other.
  for (const proposal of plan.proposals) {
    const change = planProposalChange(proposal)
    if (change) await sampleSource.saveFocusChange(change)
  }
  assert.notEqual(JSON.stringify((await sampleSource.loadWorkModel()).focusAreas), areasBefore)
})
