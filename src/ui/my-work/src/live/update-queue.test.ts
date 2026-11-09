// Run with `npm test`. The freshly-updated set (plan Phase 3, item 4).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { freshlyUpdatedRequestIds, mergeRecentChanges, RECENT_CHANGES_KEPT, requestChanges } from './update-queue.ts'

const request = (id: string, contentFingerprint: string) => ({ id, contentFingerprint }) as Request

describe('freshlyUpdatedRequestIds', () => {
  it('marks new requests and changed fingerprints, not unchanged ones', () => {
    const shown = [request('a', '1'), request('b', '2')]
    const next = [request('a', '1'), request('b', '3'), request('c', '4')]
    assert.deepEqual(freshlyUpdatedRequestIds(shown, next), ['b', 'c'])
  })
  it('marks a new request after an empty model', () => {
    assert.deepEqual(freshlyUpdatedRequestIds([], [request('a', '1')]), ['a'])
  })
})

describe('requestChanges', () => {
  const live = (id: string, state: Request['state'], percent: number | null, extra: Partial<Request> = {}) =>
    ({ id, title: `Request ${id}`, state, progress: { percent, readings: percent === null ? 0 : 1, reviewedAt: '' }, ...extra }) as Request

  it('does not report a request that went idle on the clock alone, with the same fingerprint', () => {
    const shown = [live('a', 'working', 30, { contentFingerprint: 'f1' }), live('b', 'working', 30, { contentFingerprint: 'g1' })]
    const next = [live('a', 'idle', 30, { contentFingerprint: 'f1' }), live('b', 'idle', 30, { contentFingerprint: 'g2' })]
    assert.deepEqual(requestChanges(shown, next, 5), [{ kind: 'state', requestId: 'b', title: 'Request b', from: 'working', to: 'idle', at: 5 }])
    assert.deepEqual(freshlyUpdatedRequestIds(shown, next), ['b'])
  })

  it('reports new requests, state moves and progress that went up, and nothing else', () => {
    const shown = [live('a', 'working', 30), live('b', 'working', 50), live('c', 'idle', 10)]
    const next = [live('a', 'shipped', 100), live('b', 'working', 70), live('c', 'idle', 10), live('d', 'working', null)]
    assert.deepEqual(requestChanges(shown, next, 5), [
      { kind: 'state', requestId: 'a', title: 'Request a', from: 'working', to: 'shipped', at: 5 },
      { kind: 'progress', requestId: 'b', title: 'Request b', from: 50, to: 70, at: 5 },
      { kind: 'new', requestId: 'd', title: 'Request d', at: 5 },
    ])
  })

  it('never reports a progress drop or a closed new request', () => {
    assert.deepEqual(requestChanges([live('a', 'working', 60)], [live('a', 'working', 40), live('z', 'idle', null, { closed: true })], 1), [])
  })

  it('uses the title being written while a request has no title yet', () => {
    const untitled = live('u', 'working', null, { title: null, resolvesTo: { title: 'Pending title', summary: '' } })
    assert.equal(requestChanges([live('x', 'idle', null)], [live('x', 'idle', null), untitled], 1)[0].title, 'Pending title')
  })
})

describe('mergeRecentChanges', () => {
  const change = (requestId: string, at: number) => ({ kind: 'new' as const, requestId, title: requestId, at })

  it('puts the newest first, keeps one entry per request, and caps the list', () => {
    const recent = [change('a', 1), change('b', 1)]
    assert.deepEqual(mergeRecentChanges(recent, [change('b', 2)]).map((entry) => `${entry.requestId}${entry.at}`), ['b2', 'a1'])
    const many = Array.from({ length: RECENT_CHANGES_KEPT + 5 }, (_, index) => change(`r${index}`, 3))
    assert.equal(mergeRecentChanges(recent, many).length, RECENT_CHANGES_KEPT)
  })

  it('returns the same list when nothing changed', () => {
    const recent = [change('a', 1)]
    assert.equal(mergeRecentChanges(recent, []), recent)
  })
})
