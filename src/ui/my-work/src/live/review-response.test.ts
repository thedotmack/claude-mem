// Run with `npm test`. The worker's answers to POST /api/work-view/review (WorkViewRoutes.ts:132-152, v15.0.1).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conflictReason, readReviewResponse } from './review-response.ts'

const FINGERPRINT_ON_SCREEN = 'a'.repeat(64)
const NEWER_FINGERPRINT = 'b'.repeat(64)

test('200 carries the snapshot after the save', () => {
  const snapshot = { humanRequests: [], source: { connected: true } }
  assert.deepEqual(readReviewResponse(200, snapshot), { kind: 'saved', snapshot })
})

test('200 without a snapshot fails loudly instead of pretending the screen is current', () => {
  assert.throws(() => readReviewResponse(200, null), /sent no work snapshot/)
})

test('409 is a conflict and keeps the worker message', () => {
  assert.deepEqual(readReviewResponse(409, { error: 'This request has not been reported complete.', snapshot: {} }), { kind: 'conflict', serverMessage: 'This request has not been reported complete.' })
})

test('503 shows the worker error text', () => {
  assert.deepEqual(readReviewResponse(503, { error: 'Local review storage is unavailable. Your source work is unchanged.' }), { kind: 'unavailable', serverMessage: 'Local review storage is unavailable. Your source work is unchanged.' })
})

test('every other status throws with the status and the worker error, never silently', () => {
  assert.throws(() => readReviewResponse(403, { error: 'Review changes must come from the local work viewer.' }), /\(403\): Review changes must come from the local work viewer\./)
  assert.throws(() => readReviewResponse(404, { error: 'Request is outside the loaded work.' }), /\(404\): Request is outside the loaded work\./)
  assert.throws(() => readReviewResponse(500, null), /\(500\): the worker gave no reason/)
})

test('a 409 whose latest version is the one on screen was refused as it is, not changed', () => {
  assert.equal(conflictReason(FINGERPRINT_ON_SCREEN, FINGERPRINT_ON_SCREEN), 'refused')
})

test('a 409 whose latest version differs, or is gone, changed while being read', () => {
  assert.equal(conflictReason(FINGERPRINT_ON_SCREEN, NEWER_FINGERPRINT), 'changed-while-reading')
  assert.equal(conflictReason(FINGERPRINT_ON_SCREEN, undefined), 'changed-while-reading')
})
