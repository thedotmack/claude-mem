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
