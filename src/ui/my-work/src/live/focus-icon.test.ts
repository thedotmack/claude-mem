import assert from 'node:assert/strict'
import { test } from 'node:test'
import { centerCrop, FOCUS_ICON_PICKABLE, focusIconMenu, focusIconSrc, focusIconUpload, iconDirection } from './focus-icon.ts'
import { toFocusModel } from './to-focus-model.ts'
import type { WorkViewFocusArea } from './work-view-api-types.ts'
import { MAX_FOCUS_ICON_DIRECTION_CHARS, MAX_FOCUS_ICON_UPLOAD_BYTES } from '../../../../services/work-view/focus-icon-limits.mjs'

test('an area with no icon has no picture, and an icon is read from the worker by id and version', () => {
  assert.equal(focusIconSrc({ id: 'fa_viewer' }), null)
  assert.equal(focusIconSrc({ id: 'fa_viewer', icon: '0123456789ab' }), '/api/work-view/focus-icon/fa_viewer?v=0123456789ab')
  // An id is never trusted to be a safe path segment.
  assert.equal(focusIconSrc({ id: 'a/b?c', icon: 'v1' }), '/api/work-view/focus-icon/a%2Fb%3Fc?v=v1')
  // The sample has no worker: its icon is the image itself.
  assert.equal(focusIconSrc({ id: 'fa_viewer', icon: 'data:image/png;base64,AAAA' }), 'data:image/png;base64,AAAA')
})

test('the model carries an area\'s icon version and its run, and nothing for an area with neither', () => {
  const area = (focusAreaId: string, fields: Partial<WorkViewFocusArea> = {}): WorkViewFocusArea => ({
    focusAreaId, name: focusAreaId, goal: null, status: 'kept', priorityRank: null, ownerRank: null, source: 'owner', mergedInto: null, evidence: null, decidedBy: 'owner', savedAt: null, ...fields,
  })
  const { focusAreas } = toFocusModel([area('a', { icon: '0123456789ab' }), area('b', { iconRun: { state: 'failed', error: 'The icon was refused: it has a <script> element.' } }), area('c')], [], [])
  assert.deepEqual(focusAreas.map(({ id, icon, iconRun }) => ({ id, icon, iconRun })), [
    { id: 'a', icon: '0123456789ab', iconRun: undefined },
    { id: 'b', icon: undefined, iconRun: { state: 'failed', error: 'The icon was refused: it has a <script> element.' } },
    { id: 'c', icon: undefined, iconRun: undefined },
  ])
  assert.equal('icon' in focusAreas[2] || 'iconRun' in focusAreas[2], false)
})

test('an upload is the largest centred square of the picked image', () => {
  assert.deepEqual(centerCrop(400, 400), { x: 0, y: 0, side: 400 })
  assert.deepEqual(centerCrop(1000, 400), { x: 300, y: 0, side: 400 })
  assert.deepEqual(centerCrop(300, 901), { x: 0, y: 300.5, side: 300 })
})

test('a canvas export becomes an upload only as a WebP or PNG within the worker\'s limit', () => {
  assert.deepEqual(focusIconUpload('data:image/webp;base64,UklGRg=='), { format: 'webp', data: 'UklGRg==' })
  // A browser that cannot encode WebP answers PNG by itself.
  assert.deepEqual(focusIconUpload('data:image/png;base64,iVBORw0K'), { format: 'png', data: 'iVBORw0K' })
  assert.equal(focusIconUpload('data:image/svg+xml;base64,PHN2Zz4='), null)
  assert.equal(focusIconUpload('data:image/jpeg;base64,AAAA'), null)
  assert.equal(focusIconUpload('data:,'), null)
  const base64Of = (bytes: number) => 'A'.repeat(Math.ceil(bytes / 3) * 4)
  assert.notEqual(focusIconUpload(`data:image/png;base64,${base64Of(MAX_FOCUS_ICON_UPLOAD_BYTES - 2)}`), null)
  assert.equal(focusIconUpload(`data:image/png;base64,${base64Of(MAX_FOCUS_ICON_UPLOAD_BYTES + 3)}`), null)
})

test('the picker offers the image types the owner may pick, SVG among them', () => {
  assert.deepEqual(FOCUS_ICON_PICKABLE.split(','), ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'])
})

test('the icon menu offers upload and both ways to generate, and Remove only when there is an icon', () => {
  const actions = (area: Parameters<typeof focusIconMenu>[0]) => focusIconMenu(area).map((option) => option.action)
  assert.deepEqual(actions({}), ['upload', 'generate', 'generate-with-prompt'])
  assert.deepEqual(actions({ icon: '0123456789ab' }), ['upload', 'generate', 'generate-with-prompt', 'remove'])
  assert.equal(focusIconMenu({ icon: '0123456789ab' }).some((option) => option.disabled), false)
  // A failed run leaves both Generates ready for the next click.
  assert.equal(focusIconMenu({ iconRun: { state: 'failed', error: 'no agent' } }).some((option) => option.disabled), false)
})

test('while an icon is being drawn neither Generate starts another, and an upload or removal still can', () => {
  const disabled = focusIconMenu({ icon: '0123456789ab', iconRun: { state: 'generating', error: null } }).filter((option) => option.disabled).map((option) => option.action)
  assert.deepEqual(disabled, ['generate', 'generate-with-prompt'])
})

test('a typed direction is sent trimmed and within the limit, and nothing typed sends none', () => {
  assert.equal(iconDirection('  a paper airplane, warm colors  '), 'a paper airplane, warm colors')
  assert.equal(iconDirection('   '), null)
  assert.equal(iconDirection('x'.repeat(MAX_FOCUS_ICON_DIRECTION_CHARS + 50)), 'x'.repeat(MAX_FOCUS_ICON_DIRECTION_CHARS))
})
