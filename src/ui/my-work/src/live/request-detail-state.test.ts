import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { sampleSource } from './sample-source.ts'
import { mergeRequestDetail, requestDetailKey, requestDetailToShow, requestOnScreen, type RequestDetailRead } from './request-detail-state.ts'

it('combines current card status with complete detail rather than replacing it with empty overview arrays', async () => {
  const full = (await sampleSource.loadWorkModel()).requests[0]
  const summary = { ...full, checkedAt: 'just now', title: 'Current title', detailLoaded: false, detailRevision: 'version', granular: [], workstreams: [], conversations: [], prompts: [], story: [], evidence: [], workProduct: [] }
  const merged = mergeRequestDetail(summary, full)
  assert.equal(merged.title, 'Current title')
  assert.equal(merged.checkedAt, 'just now')
  assert.equal(merged.detailLoaded, true)
  assert.equal(merged.granular, full.granular)
  assert.equal(merged.workProduct, full.workProduct)
  assert.notEqual(requestDetailKey(summary), requestDetailKey({ ...summary, detailRevision: 'next' }))
})

it('keeps the detail’s confidence for the suggestion the card still shows, and never brings back one the card no longer has', async () => {
  const request = (await sampleSource.loadWorkModel()).requests[0]
  const suggestion = { conversationKey: '["conversation","claude","session-1"]', requestId: 'g_000000000001', requestTitle: 'Related request',
    evidence: 'The same release', confidence: 0.74, expectedSuggestionHash: 'suggestion-hash', sharedConflict: false }
  const { confidence: _confidence, ...onTheCard } = suggestion
  const detail: Request = { ...request, suggestion }
  // The overview leaves the score out of its cards (src/services/work-view/overview.ts compactRequest).
  const summary: Request = { ...request, detailLoaded: false, suggestion: onTheCard }
  assert.deepEqual(mergeRequestDetail(summary, detail).suggestion, suggestion)
  // Answered: the newer card has none, and the older detail still on screen does not bring it back.
  assert.equal(mergeRequestDetail({ ...summary, suggestion: undefined }, detail).suggestion, undefined)
  // A different suggestion keeps its own words and borrows no score.
  const another = { ...onTheCard, requestId: 'g_000000000002' }
  assert.deepEqual(mergeRequestDetail({ ...summary, suggestion: another }, detail).suggestion, another)
})

/** One version of a request's detail, as a read brings it back. */
const version = (request: Request, detailRevision: string): Request => ({ ...request, detailRevision })
const loading = (request: Request): RequestDetailRead => ({ key: requestDetailKey(request) })
const loaded = (request: Request): RequestDetailRead => ({ key: requestDetailKey(request), request })
// The sentence local-source.ts throws when a request changes while its detail loads.
const changedWhileLoading = 'This request changed while its detail was loading. Try again.'

describe('which detail the open request drawer shows', () => {
  it('shows the loading page on the first read of a request: nothing of it was read yet', async () => {
    const request = version((await sampleSource.loadWorkModel()).requests[0], 'first')
    assert.equal(requestDetailToShow(request.id, null, null), null)
    assert.equal(requestDetailToShow(request.id, loading(request), null), null)
    // A first read that fails has nothing to keep: the failure page shows it, with "Try again".
    assert.equal(requestDetailToShow(request.id, { key: requestDetailKey(request), error: changedWhileLoading }, null), null)
  })

  it('keeps the last detail of the same request on screen while its newer version loads', async () => {
    const sample = (await sampleSource.loadWorkModel()).requests[0]
    const older = version(sample, 'before the continued turn')
    const newer = version(sample, 'after the continued turn')
    // Before the newer read starts (the last read is of the older version), and once it has started.
    assert.deepEqual(requestDetailToShow(newer.id, null, loaded(older)), { request: older })
    assert.deepEqual(requestDetailToShow(newer.id, loading(newer), loaded(older)), { request: older })
  })

  it('swaps in the newer detail when it arrives', async () => {
    const sample = (await sampleSource.loadWorkModel()).requests[0]
    const older = version(sample, 'before the continued turn')
    const newer = version(sample, 'after the continued turn')
    assert.deepEqual(requestDetailToShow(newer.id, loaded(newer), loaded(older)), { request: newer })
    assert.deepEqual(requestDetailToShow(newer.id, loaded(newer), loaded(newer)), { request: newer })
  })

  it('keeps the older detail and brings the failure with it when the newer version fails to load', async () => {
    const sample = (await sampleSource.loadWorkModel()).requests[0]
    const older = version(sample, 'before the continued turn')
    const newer = version(sample, 'after the continued turn')
    const failedRead: RequestDetailRead = { key: requestDetailKey(newer), error: changedWhileLoading }
    assert.deepEqual(requestDetailToShow(newer.id, failedRead, loaded(older)), { request: older, newerVersionReadFailure: changedWhileLoading })
  })

  it('shows the loading page for a different request, never the last request’s detail', async () => {
    const [first, second] = (await sampleSource.loadWorkModel()).requests
    assert.notEqual(first.id, second.id)
    const firstRead = loaded(version(first, 'read before'))
    assert.equal(requestDetailToShow(second.id, null, firstRead), null)
    assert.equal(requestDetailToShow(second.id, loading(version(second, 'opened')), firstRead), null)
    // A different request whose first read failed shows the failure page, not the last request's detail.
    assert.equal(requestDetailToShow(second.id, { key: requestDetailKey(second), error: changedWhileLoading }, firstRead), null)
  })
})

describe('the version the drawer’s review actions act on', () => {
  const OLDER_FINGERPRINT = 'a'.repeat(64)
  const NEWER_FINGERPRINT = 'b'.repeat(64)

  /**
   * The detail read before a continued turn, and the card once that turn's records arrived: a newer version, whose
   * detail is not read yet. The card's evidence arrays are empty, as the overview leaves them out.
   */
  async function olderDetailAndNewerCard(newerFingerprint: string) {
    const sample = (await sampleSource.loadWorkModel()).requests[0]
    const older: Request = { ...version(sample, 'before the continued turn'), contentFingerprint: OLDER_FINGERPRINT }
    const newerCard: Request = {
      ...version(sample, 'after the continued turn'), detailLoaded: false, contentFingerprint: newerFingerprint,
      state: 'needs-check', review: { mode: 'local', hash: 'the review decisions the check box shows', available: true },
      granular: [], workstreams: [], conversations: [], prompts: [], story: [], evidence: [], workProduct: [],
    }
    assert.ok(older.granular.length > 0 && older.workProduct.length > 0 && older.conversations.length > 0, 'the older detail has evidence to show')
    return { older, newerCard }
  }

  it('is the older version while its detail stays on screen, so the worker refuses to check it', async () => {
    const { older, newerCard } = await olderDetailAndNewerCard(NEWER_FINGERPRINT)
    const failedRead: RequestDetailRead = { key: requestDetailKey(newerCard), error: changedWhileLoading }
    // While the newer version's detail loads, and after its read failed.
    for (const currentVersionRead of [loading(newerCard), failedRead]) {
      const shown = requestDetailToShow(newerCard.id, currentVersionRead, loaded(older))
      assert.ok(shown)
      const onScreen = requestOnScreen(newerCard, shown.request)
      // The review actions send this fingerprint. The worker checks it against the current version's and refuses it
      // with its "This work changed" sentence (WorkViewRoutes.ts, review), which the page shows as changed while reading.
      assert.equal(onScreen.contentFingerprint, OLDER_FINGERPRINT)
      // The version it names is the one whose evidence is on screen.
      assert.deepEqual(onScreen.granular, older.granular)
      assert.deepEqual(onScreen.workProduct, older.workProduct)
      assert.deepEqual(onScreen.conversations, older.conversations)
      // The check box still shows the card's status and review decisions: nothing in it is hidden or changed.
      assert.equal(onScreen.state, 'needs-check')
      assert.deepEqual(onScreen.review, newerCard.review)
    }
  })

  it('names the card’s version when the newer one changed only generated words, so checking it still saves', async () => {
    // Same recorded content, new copy or progress: a new detail version, the same fingerprint.
    const { older, newerCard } = await olderDetailAndNewerCard(OLDER_FINGERPRINT)
    const shown = requestDetailToShow(newerCard.id, loading(newerCard), loaded(older))
    assert.ok(shown)
    assert.equal(requestOnScreen(newerCard, shown.request).contentFingerprint, newerCard.contentFingerprint)
  })
})
