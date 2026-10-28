// The sample source applies My Focus changes the way the worker does (WorkViewRoutes `saveFocus`), refusals included.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sampleSource } from './sample-source.ts'

const ids = (areas: { id: string }[]) => areas.map((area) => area.id)

test('areas are in the worker\'s order from the start: the owner\'s order, then suggested priority', async () => {
  const { focusAreas } = await sampleSource.loadWorkModel()
  assert.deepEqual(ids(focusAreas.slice(0, 4)), ['fa-viewer', 'fa-sync', 'fa-search', 'fa-behavior'])
})

test('reorder covers kept areas only, all of them, and never touches a suggestion', async () => {
  await assert.rejects(sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-viewer', 'fa-search', 'fa-behavior', 'fa-decks'] }), /List every kept focus area, each once/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-viewer'] }), /List every kept focus area, each once/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-sync'] }), /Each focus area can appear once/)
  const model = await sampleSource.saveFocusChange({ action: 'reorder', focusAreaIds: ['fa-sync', 'fa-viewer', 'fa-search', 'fa-behavior'] })
  assert.deepEqual(ids(model.focusAreas.slice(0, 4)), ['fa-sync', 'fa-viewer', 'fa-search', 'fa-behavior'])
  assert.equal(model.focusAreas.find((area) => area.id === 'fa-decks')!.ownerRank, null)
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
