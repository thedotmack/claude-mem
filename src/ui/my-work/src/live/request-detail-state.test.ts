import assert from 'node:assert/strict'
import { it } from 'node:test'
import { sampleSource } from './sample-source.ts'
import { mergeRequestDetail, requestDetailKey } from './request-detail-state.ts'

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

it('never pairs an older version\'s evidence with the newest version\'s fingerprint', async () => {
  const full = (await sampleSource.loadWorkModel()).requests[0]
  const read = { ...full, contentFingerprint: 'a'.repeat(64), review: { mode: 'shared' as const, hash: 'read', available: true } }
  const newer = { ...read, contentFingerprint: 'b'.repeat(64), review: { mode: 'shared' as const, hash: 'newer', available: true }, detailLoaded: false, detailRevision: 'next', workProduct: [], evidence: [] }
  const stale = mergeRequestDetail(newer, read)
  assert.equal(stale.workProduct, read.workProduct)
  assert.equal(stale.contentFingerprint, read.contentFingerprint)
  assert.equal(stale.review?.hash, 'read')
  const reloaded = mergeRequestDetail(newer, { ...newer, workProduct: read.workProduct })
  assert.equal(reloaded.contentFingerprint, newer.contentFingerprint)
  assert.equal(reloaded.review?.hash, 'newer')
})
