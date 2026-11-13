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

it('takes the question whole from the detail read, so a newer question never sits beside an older one\'s background', async () => {
  const full = (await sampleSource.loadWorkModel()).requests[0]
  const asked = { need: 'answer' as const, text: 'Linear or seasonal?', version: 'review-1', background: ['Linear matched within 4%.'] }
  const detail = { ...full, question: asked, stages: [{ formatId: 'brief', state: 'ready' as const, href: '/api/deliverables/1/stage.md', error: null, outdated: false }] }
  // A summary that carried the next review's question (a full-snapshot source does) must not lend its text to this detail.
  const summary = { ...full, detailLoaded: false, question: { need: 'answer' as const, text: 'Ship today or Monday?', version: 'review-2', background: [] } }
  const merged = mergeRequestDetail(summary, detail)
  assert.deepEqual(merged.question, asked)
  assert.equal(merged.stages, detail.stages)
  // The question's version is part of what the drawer reads again for: the old detail is not shown for the new one.
  assert.equal(mergeRequestDetail({ ...full, detailLoaded: false }, { ...full, question: undefined }).question, undefined)
})
