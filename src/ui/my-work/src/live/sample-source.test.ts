// The sample source applies My Focus changes the way the worker does (WorkViewRoutes `saveFocus`), refusals included.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sampleSource } from './sample-source.ts'

test('notes are the owner\'s text on an area: saved, cleared when emptied, refused past 2000 characters', async () => {
  let model = await sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search', notes: '  Why it matters: I lose an hour a day looking.  ' })
  assert.equal(model.focusAreas.find((area) => area.id === 'fa-search')!.notes, 'Why it matters: I lose an hour a day looking.')
  await assert.rejects(sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search', notes: 'x'.repeat(2001) }), /ValidationError/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search' }), /Send the notes to save/)
  await assert.rejects(sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'missing', notes: 'x' }), /not in your focus areas/)
  model = await sampleSource.saveFocusChange({ action: 'edit-notes', focusAreaId: 'fa-search', notes: '' })
  assert.equal(model.focusAreas.find((area) => area.id === 'fa-search')!.notes, null)
})
