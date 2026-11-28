// Sample mode answers the sub focus edits as the worker does (WorkViewRoutes saveFocus), word for word.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FocusChange } from '../data.ts'
import { sampleSource } from './sample-source.ts'

const refusal = (change: FocusChange) => sampleSource.saveFocusChange(change).then(() => null, (error: Error) => error.message)

test('an action the worker does not know is refused as unknown, before any area is looked up', async () => {
  assert.equal(await refusal({ action: 'split-sub-focus' } as unknown as FocusChange), 'Unknown focus change: split-sub-focus')
})

test('a sub focus rename or merge names a sub focus the areas hold', async () => {
  assert.equal(await refusal({ action: 'rename-sub-focus', subFocusId: 'sf_missing', name: 'New' }), 'That sub focus is not in your focus areas.')
  assert.equal(await refusal({ action: 'merge-sub-focus', subFocusId: 'sf_missing', intoSubFocusId: 'sf_other' }), 'That sub focus is not in your focus areas.')
})

test('a move to a sub focus stays inside the request\'s own area, and a move to none leaves it ungrouped there', async () => {
  assert.equal(await refusal({ action: 'move-to-sub-focus', requestId: 'r1' }), 'Choose the request and the sub focus to move it to.')
  assert.equal(await refusal({ action: 'move-to-sub-focus', requestId: 'missing', subFocusId: null }), 'That request is not in your work.')
  // r5 is in Other, which has no sub focuses.
  assert.equal(await refusal({ action: 'move-to-sub-focus', requestId: 'r5', subFocusId: null }), 'Put this request in a focus area before choosing its sub focus.')
  assert.equal(await refusal({ action: 'move-to-sub-focus', requestId: 'r1', subFocusId: 'sf_elsewhere' }), 'Move it to a sub focus of the area it is in.')
  const model = await sampleSource.saveFocusChange({ action: 'move-to-sub-focus', requestId: 'r1', subFocusId: null })
  const request = model.requests.find((entry) => entry.id === 'r1')!
  assert.equal(request.focusAreaId, 'fa-viewer')
  assert.equal('subFocusId' in request, false)
})
