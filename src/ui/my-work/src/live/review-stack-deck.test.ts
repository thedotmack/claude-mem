import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ReviewStackSnapshot } from '../../../../shared/review-stack.ts'
import { readReviewStack, originalHttps } from './review-stack-client.ts'
import { reviewAreaOptions, reviewDeck, horizontalTravel, milestoneCrossed } from './review-stack-deck.ts'
import { readReviewManifest, importReviewManifest } from './review-stack-import.ts'

const card = (id: string, focus = 'Design') => ({ id, key: id, focus, title: 'Recorded project deliverable', what: 'A genuine original card.', context: 'The project this card belongs to.', excerpt: 'Source evidence.', createdAt: 1 })
const empty: ReviewStackSnapshot = { revision: 'r1', cards: [], reviews: [], bookmarks: [], followUps: [], groups: [] }

test('a Browse deck includes reviewed originals; Work revisits only skips selected for this pass', () => {
  const snapshot: ReviewStackSnapshot = { ...empty, cards: [card('a'), card('b', 'design'), card('c'), card('d', 'Other')], reviews: [
    { id: 'seen-a', cardId: 'a', action: 'seen', createdAt: 2 }, { id: 'skip-b', cardId: 'b', action: 'skip', createdAt: 3 },
  ], bookmarks: [{ cardId: 'c', saved: true, revision: 1 }] }
  assert.deepEqual(reviewDeck(snapshot, 'Design', new Set()).cards.map(c => c.id), ['a', 'b', 'c'])
  assert.deepEqual(reviewDeck(snapshot, 'Design', new Set()).pending.map(c => c.id), ['c'])
  assert.deepEqual(reviewDeck(snapshot, 'Design', new Set(['skip-b'])).pending.map(c => c.id), ['b', 'c'])
  assert.ok(horizontalTravel(65, 3, 400)); assert.equal(horizontalTravel(30, 90, 400), false)
  assert.ok(milestoneCrossed(4, 5)); assert.equal(milestoneCrossed(5, 5), false)
  assert.equal(originalHttps('javascript:alert(1)'), undefined); assert.equal(originalHttps('https://user@example.com'), undefined)
})

test('identical masked labels offer distinct areas and filter only their original card IDs', () => {
  const cards = [
    { ...card('b', 'Private'), focusId:'focus-b' }, { ...card('a', 'Private'), focusId:'focus-a' },
    { ...card('a2', 'Private'), focusId:'focus-a' }, card('legacy', 'Design'),
  ]
  const options = reviewAreaOptions(cards)
  assert.equal(options.get('focus-a'), 'Private (1)')
  assert.equal(options.get('focus-b'), 'Private (2)')
  assert.equal(options.get('design'), 'Design')
  assert.deepEqual(reviewDeck({ ...empty, cards }, 'focus-a', new Set()).cards.map(c => c.id), ['a','a2'])
})

test('a stale cursor restarts the read before publishing any partially assembled deck', async () => {
  const calls: string[] = []
  const responses = [
    Response.json({ ...empty, cards: [card('old')], nextCursor: 'page1' }),
    Response.json({ error: 'changed' }, { status: 409 }),
    Response.json({ ...empty, revision: 'r2', cards: [card('new')], nextCursor: 'a&b' }),
    Response.json({ ...empty, revision: 'r2', cards: [card('other')], nextCursor: null }),
  ]
  const result = await readReviewStack(new AbortController().signal, async url => { calls.push(String(url)); return responses.shift()! })
  assert.deepEqual(result.cards.map(item => item.id), ['new', 'other'])
  assert.equal(result.revision, 'r2'); assert.match(calls[3], /cursor=a%26b$/)
})

test('an interrupted manifest keeps receipts and retries the uncertain batch with its original key', async () => {
  const cards = Array.from({ length: 14 }, (_, index) => card('original-' + index))
  const job = await readReviewManifest([new File([JSON.stringify({ cards })], 'cards.json')])
  const calls: { size: number; key: string }[] = []
  const send = async (batch: typeof job.cards, key: string) => {
    assert.equal(Object.hasOwn(batch[0], 'id'), false)
    calls.push({ size: batch.length, key }); if (calls.length === 2) throw new Error('Connection lost')
    return { added: batch.length, existing: 0, firstId: batch[0].key }
  }
  const noImages = async () => { throw new Error('unexpected image') }
  await assert.rejects(importReviewManifest(job, () => {}, noImages, send), /Connection lost/)
  assert.equal(job.offset, 12); assert.equal(job.added, 12)
  await importReviewManifest(job, () => {}, noImages, send)
  assert.deepEqual(calls.map(call => call.size), [12, 2, 2]); assert.equal(calls[1].key, calls[2].key); assert.equal(job.added, 14)
  await assert.rejects(readReviewManifest([new File([JSON.stringify({ cards: [{ ...cards[0], imageFile: 'missing.png' }] })], 'cards.json')]), /Select the image missing/)
})
