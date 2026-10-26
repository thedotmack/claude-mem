// Run with `npm test`. The freshly-updated set (plan Phase 3, item 4).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { freshlyUpdatedRequestIds } from './update-queue.ts'

const request = (id: string, contentFingerprint: string) => ({ id, contentFingerprint }) as Request

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
