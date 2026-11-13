// The sample source applies My Focus changes the way the worker does (WorkViewRoutes `saveFocus`), refusals included.
import assert from 'node:assert/strict'
import { stageReading } from './stage-reader.ts'
import { sampleStageHref } from './sample-stages.ts'
import { test } from 'node:test'
import { sampleSource, setSampleRunDelay } from './sample-source.ts'
import { planProposalChange } from './owner-runs-model.ts'
import type { WorkModel } from './work-data-source.ts'

const ids = (areas: { id: string }[]) => areas.map((area) => area.id)

test('areas are in the worker\'s order from the start: the owner\'s order, then suggested priority', async () => {
  const { focusAreas } = await sampleSource.loadWorkModel()
  assert.deepEqual(ids(focusAreas.slice(0, 4)), ['fa-viewer', 'fa-sync', 'fa-search', 'fa-behavior'])
})

test('reorder lists every kept area, never touches a suggestion left out, and keeps one that is listed at its place', async () => {
  await assert.rejects(sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-viewer'] }), /List every kept focus area, each once/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-sync'] }), /Each focus area can appear once/)
  let model = await sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-viewer', 'fa-search', 'fa-behavior'] })
  assert.deepEqual(ids(model.focusAreas.slice(0, 4)), ['fa-sync', 'fa-viewer', 'fa-search', 'fa-behavior'])
  assert.deepEqual([model.focusAreas.find((area) => area.id === 'fa-decks')!.ownerRank, model.focusAreas.find((area) => area.id === 'fa-decks')!.status], [null, 'suggested'])
  model = await sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-decks', 'fa-viewer', 'fa-search', 'fa-behavior'] })
  assert.deepEqual(ids(model.focusAreas.slice(0, 5)), ['fa-sync', 'fa-decks', 'fa-viewer', 'fa-search', 'fa-behavior'])
  assert.deepEqual([model.focusAreas[1].status, model.focusAreas[1].ownerRank], ['kept', 2])
  // Undo's two steps: back to a suggestion and out of the order, then the order as it was.
  model = await sampleSource.saveFocusChange({ action: 'restore-suggestion', focusAreaId: 'fa-decks' })
  assert.deepEqual([model.focusAreas.find((area) => area.id === 'fa-decks')!.ownerRank, model.focusAreas.find((area) => area.id === 'fa-decks')!.status], [null, 'suggested'])
  await sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-viewer', 'fa-search', 'fa-behavior'] })
})

test('filed under no project, a focus leaves its folder guess and stays out; an empty filing puts it back on the guess', async () => {
  let model = await sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-team'], initiative: '', noInitiative: true })
  const team = () => model.focusAreas.find((area) => area.id === 'fa-team')!
  assert.deepEqual([team().initiative, team().initiativeGuess, team().initiativeNone], [undefined, undefined, true])
  await assert.rejects(sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-team'], initiative: 'Sync', noInitiative: true }), /carries no name/)
  model = await sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-team'], initiative: '' })
  assert.deepEqual([team().initiative, team().initiativeGuess, team().initiativeNone], ['sync-service', true, undefined])
})

test('a rename that reuses a nav word, or a name past 80 characters, is refused as the worker refuses it', async () => {
  await assert.rejects(sampleSource.saveFocusChange({ action: 'rename', focusAreaId: 'fa-search', name: 'My Work' }), /"My Work" reuses the nav word "my work"/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'rename', focusAreaId: 'fa-search', name: 'x'.repeat(81) }), /ValidationError/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'edit-goal', focusAreaId: 'fa-search', goal: 'x'.repeat(301) }), /ValidationError/)
  const model = await sampleSource.saveFocusChange({ action: 'rename', focusAreaId: 'fa-search', name: 'Work search' })
  assert.equal(model.focusAreas.find((area) => area.id === 'fa-search')!.name, 'Work search')
})

test('merge refusals match the worker, and an unknown action throws', async () => {
  await assert.rejects(sampleSource.saveFocusChange({ action: 'merge', focusAreaId: 'fa-growth', intoFocusAreaId: 'fa-growth' }), /An area cannot be merged into itself/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'merge', focusAreaId: 'fa-growth', intoFocusAreaId: 'missing' }), /That focus area is not in your focus areas/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'archive' as never, focusAreaId: 'fa-growth' }), /Unknown focus change: archive/)
})

// The sample plays the worker's one-click runs: a start, then the result through the feed, and never a second run for one click.
setSampleRunDelay(5)
const afterRun = () => new Promise((resolve) => setTimeout(resolve, 25))
const request = (model: WorkModel, id: string) => model.requests.find((entry) => entry.id === id)!

test('notes are the owner\'s text on an area: saved, cleared when emptied, refused past 2000 characters', async () => {
  let model = await sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search', notes: '  Why it matters: I lose an hour a day looking.  ' })
  assert.equal(model.focusAreas.find((area) => area.id === 'fa-search')!.notes, 'Why it matters: I lose an hour a day looking.')
  await assert.rejects(sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search', notes: 'x'.repeat(2001) }), /ValidationError/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search' }), /Send the notes to save/)
  model = await sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search', notes: '' })
  assert.equal(model.focusAreas.find((area) => area.id === 'fa-search')!.notes, null)
})

test('initiatives play without a worker: rename a heading, merge two, move one focus, and clear back to the guess', async () => {
  const initiativeOf = (model: WorkModel, id: string) => { const area = model.focusAreas.find((entry) => entry.id === id)!; return [area.initiative, area.initiativeGuess] }
  let model = await sampleSource.loadWorkModel()
  assert.deepEqual(initiativeOf(model, 'fa-search'), ['viewer-web', true])
  // Rename: every focus under the heading in one change.
  model = await sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-viewer', 'fa-fixes'], initiative: '  Viewer  ' })
  assert.deepEqual([initiativeOf(model, 'fa-viewer'), initiativeOf(model, 'fa-fixes')], [['Viewer', undefined], ['Viewer', undefined]])
  // Merge: the other heading renamed to that name, in any case, keeps the spelling filed first.
  model = await sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-search'], initiative: 'viewer' })
  assert.deepEqual(initiativeOf(model, 'fa-search'), ['Viewer', undefined])
  // Move one, then clear it: back to the guess it started with.
  model = await sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-sync'], initiative: 'Viewer' })
  assert.deepEqual(initiativeOf(model, 'fa-sync'), ['Viewer', undefined])
  model = await sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-sync'], initiative: '' })
  assert.deepEqual(initiativeOf(model, 'fa-sync'), ['sync-service', true])
  await assert.rejects(sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-sync'], initiative: 'x'.repeat(61) }), /ValidationError/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['nope'], initiative: 'x' }), /not in your focus areas/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-sync'] }), /Send the focus areas/)
  model = await sampleSource.saveFocusChange({ action: 'set-initiative', focusAreaIds: ['fa-viewer', 'fa-fixes', 'fa-search'], initiative: '' })
  assert.deepEqual([initiativeOf(model, 'fa-viewer'), initiativeOf(model, 'fa-search')], [['viewer-app', true], ['viewer-web', true]])
})

test('an answer is on its way, then delivered; the same click starts nothing twice; a tool that cannot be resumed refuses', async () => {
  const fed: WorkModel[] = []
  const stop = sampleSource.subscribeToLiveUpdates((model) => fed.push(model), () => {})
  assert.deepEqual(await sampleSource.answerRequest!('r1', 'Keep the list view.', 'click-a1'), { outcome: 'started' })
  assert.deepEqual(request(await sampleSource.loadWorkModel(), 'r1').answer, { state: 'answering' })
  assert.deepEqual(await sampleSource.answerRequest!('r1', 'Keep the list view.', 'click-a1'), { outcome: 'duplicate' })
  await assert.rejects(sampleSource.answerRequest!('r1', 'again', 'click-a2'), /still being delivered/)
  await afterRun()
  assert.deepEqual(fed.map((model) => request(model, 'r1').answer?.state), ['answering', 'delivered'])
  const refused = await sampleSource.answerRequest!('r5', 'Linear.', 'click-a3')
  assert.equal(refused.outcome, 'refused')
  assert.match((refused as { reason: string }).reason, /Claude Code and Codex sessions only/)
  assert.equal(request(await sampleSource.loadWorkModel(), 'r5').answer, undefined)
  stop()
})

test('a stage is generating, then ready to open, in a format the model lists', async () => {
  const fed: WorkModel[] = []
  const stop = sampleSource.subscribeToLiveUpdates((model) => fed.push(model), () => {})
  const model = await sampleSource.loadWorkModel()
  assert.deepEqual(model.stageFormats!.map((format) => format.id), ['brief', 'one-pager', 'deck', 'technical'])
  await assert.rejects(sampleSource.generateStage!('r3', 'video', 'click-s0'), /That stage format does not exist/)
  assert.deepEqual(await sampleSource.generateStage!('r3', 'deck', 'click-s1'), { outcome: 'started' })
  assert.deepEqual(await sampleSource.generateStage!('r3', 'deck', 'click-s1'), { outcome: 'duplicate' })
  await assert.rejects(sampleSource.generateStage!('r3', 'deck', 'click-s2'), /already being made/)
  await afterRun()
  assert.deepEqual(fed.map((entry) => request(entry, 'r3').stages![0].state), ['generating', 'ready'])
  assert.deepEqual(request(fed[0], 'r3').readyStages, undefined)
  assert.deepEqual(request(fed[1], 'r3').readyStages, ['deck'])
  // The sample stage is a document the reader can open: its text rides in its address.
  const reading = stageReading(request(fed[1], 'r3').stages![0], model.stageFormats!)!
  assert.deepEqual([reading.output, reading.newTabHref, reading.href.startsWith('data:text/html')], ['html', null, true])
  // The sample brief shows an image the page itself serves, so the reader has one to load.
  assert.match(decodeURIComponent(sampleStageHref(model.stageFormats![0])), /!\[Write stalls per hour, before and after\]\(sample-stage-evidence\.svg\)/)
  stop()
})

test('automatic stages are off until chosen, and choosing a format makes no stage', async () => {
  assert.equal((await sampleSource.loadWorkModel()).autoStageFormat, null)
  const model = await sampleSource.setAutoStageFormat!('brief')
  assert.equal(model.autoStageFormat, 'brief')
  assert.equal(model.requests.some((entry) => entry.stages?.some((stage) => stage.trigger === 'auto')), false)
  await assert.rejects(sampleSource.setAutoStageFormat!('video'), /That stage format does not exist/)
  assert.equal((await sampleSource.setAutoStageFormat!(null)).autoStageFormat, null)
})

test('a plan is suggestions only: nothing changes until a proposal is saved by the owner\'s own action', async () => {
  const fed: WorkModel[] = []
  const stop = sampleSource.subscribeToLiveUpdates((model) => fed.push(model), () => {})
  const before = (await sampleSource.loadWorkModel()).focusAreas
  assert.deepEqual(await sampleSource.planFocus!(null, 'click-p1'), { outcome: 'started' })
  assert.deepEqual(await sampleSource.planFocus!(null, 'click-p1'), { outcome: 'duplicate' })
  await assert.rejects(sampleSource.planFocus!(null, 'click-p2'), /already being made/)
  await afterRun()
  assert.deepEqual(fed.map((model) => model.focusPlan?.state), ['planning', 'ready'])
  const plan = (await sampleSource.loadFocusPlan!())!
  assert.equal(fed[1].focusPlan!.proposals, plan.proposals.length)
  assert.deepEqual((await sampleSource.loadWorkModel()).focusAreas, before)
  assert.deepEqual([...new Set(plan.proposals.map((proposal) => proposal.kind))].sort(), ['goal', 'initiative', 'next-asks', 'notes', 'reorder'])
  // Every proposal that can be applied is one the focus actions accept.
  for (const proposal of plan.proposals) {
    const change = planProposalChange(proposal)
    if (change) await sampleSource.saveFocusChange(change)
  }
  const reorder = plan.proposals.find((proposal) => proposal.kind === 'reorder')!
  const after = (await sampleSource.loadWorkModel()).focusAreas
  assert.deepEqual(ids(after.filter((area) => area.status === 'kept' && !area.mergedInto)), reorder.kind === 'reorder' ? reorder.focusAreaIds : [])
  await assert.rejects(sampleSource.planFocus!('missing', 'click-p3'), /not in your focus areas/)
  stop()
})

test('a focus icon is the owner\'s: uploaded, drawn once per click, or removed, and never there unasked', async () => {
  const fed: WorkModel[] = []
  const stop = sampleSource.subscribeToLiveUpdates((model) => fed.push(model), () => {})
  const iconOf = (model: WorkModel, id: string) => model.focusAreas.find((area) => area.id === id)!
  const [first, second] = (await sampleSource.loadWorkModel()).focusAreas
  assert.equal((await sampleSource.loadWorkModel()).focusAreas.some((area) => area.icon || area.iconRun), false)

  const uploaded = await sampleSource.setFocusIcon!(first.id, { format: 'png', data: 'iVBORw0K' })
  assert.equal(iconOf(uploaded, first.id).icon, 'data:image/png;base64,iVBORw0K')
  assert.equal(iconOf(uploaded, second.id).icon, undefined)
  await assert.rejects(sampleSource.setFocusIcon!('missing', null), /not in your focus areas/)

  assert.deepEqual(await sampleSource.generateFocusIcon!(second.id, 'click-i1'), { outcome: 'started' })
  assert.deepEqual(await sampleSource.generateFocusIcon!(second.id, 'click-i1'), { outcome: 'duplicate' })
  await assert.rejects(sampleSource.generateFocusIcon!(second.id, 'click-i2'), /already being generated/)
  await assert.rejects(sampleSource.generateFocusIcon!('missing', 'click-i3'), /not in your focus areas/)
  await afterRun()
  assert.deepEqual(fed.map((model) => iconOf(model, second.id).iconRun?.state), ['generating', undefined])
  assert.match(iconOf(fed[1], second.id).icon!, /^data:image\/svg\+xml,/)

  // An upload made while a run is out stands: the run's icon is not put over it.
  assert.deepEqual(await sampleSource.generateFocusIcon!(first.id, 'click-i4'), { outcome: 'started' })
  await sampleSource.setFocusIcon!(first.id, { format: 'webp', data: 'UklGRg==' })
  await afterRun()
  assert.equal(iconOf(await sampleSource.loadWorkModel(), first.id).icon, 'data:image/webp;base64,UklGRg==')

  // A typed direction plays the same run and ends in another picture.
  const plain = iconOf(await sampleSource.loadWorkModel(), second.id).icon
  assert.deepEqual(await sampleSource.generateFocusIcon!(second.id, 'click-i5', 'a paper airplane, warm colors'), { outcome: 'started' })
  await afterRun()
  const directed = iconOf(await sampleSource.loadWorkModel(), second.id).icon!
  assert.match(directed, /^data:image\/svg\+xml,/)
  assert.notEqual(directed, plain)

  const removed = await sampleSource.setFocusIcon!(first.id, null)
  assert.equal('icon' in iconOf(removed, first.id), false)
  await sampleSource.setFocusIcon!(second.id, null)
  stop()
})
