// Run with `npm test`. The hold-while-reading rule and the freshly-updated set (plan Phase 3, item 4).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { freshlyUpdatedRequestIds, READING_SCROLL_Y, shouldHoldWorkModelUpdate } from './update-queue.ts'

const notReading = { dialogOpen: false, focusInControl: false, scrollY: 0 }
const request = (id: string, contentFingerprint: string) => ({ id, contentFingerprint }) as Request

describe('shouldHoldWorkModelUpdate', () => {
  it('applies immediately when the person is not reading', () => {
    assert.equal(shouldHoldWorkModelUpdate(true, notReading), false)
  })
  it('holds while a drawer is open, focus is in a control, or the page is scrolled past the threshold', () => {
    assert.equal(shouldHoldWorkModelUpdate(true, { ...notReading, dialogOpen: true }), true)
    assert.equal(shouldHoldWorkModelUpdate(true, { ...notReading, focusInControl: true }), true)
    assert.equal(shouldHoldWorkModelUpdate(true, { ...notReading, scrollY: READING_SCROLL_Y + 1 }), true)
    assert.equal(shouldHoldWorkModelUpdate(true, { ...notReading, scrollY: READING_SCROLL_Y }), false)
  })
  it('never holds the first work shown', () => {
    assert.equal(shouldHoldWorkModelUpdate(false, { dialogOpen: true, focusInControl: true, scrollY: 999 }), false)
  })
})

describe('freshlyUpdatedRequestIds', () => {
  it('marks new requests and changed fingerprints, not unchanged ones', () => {
    const shown = [request('a', '1'), request('b', '2')]
    const next = [request('a', '1'), request('b', '3'), request('c', '4')]
    assert.deepEqual(freshlyUpdatedRequestIds(shown, next), ['b', 'c'])
  })
  it('marks nothing on the first model', () => {
    assert.deepEqual(freshlyUpdatedRequestIds([], [request('a', '1')]), [])
  })
})
