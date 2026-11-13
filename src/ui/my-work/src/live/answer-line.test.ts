// Run with `npm test`. What a thread row keeps and shows about answering the agent (components/thread-list.tsx AnswerLine).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { answerDelivery, backgroundFor, keptSentAnswers, questionVersion, type KeptBackground } from './answer-line.ts'

const asking = (text: string, change: Partial<Pick<Request, 'detailRevision'>> & { background?: { text: string }[]; hasBackground?: true } = {}): Pick<Request, 'question' | 'detailRevision'> => {
  const { detailRevision = 'r1', ...question } = change
  return { detailRevision, question: { text, ...question } }
}

describe('"What you may need" on a row whose question changes under it', () => {
  const first = asking('Ship on Friday or Monday?', { hasBackground: true })
  const read: KeptBackground = { version: questionVersion(first), open: true, items: [{ text: 'Friday is the freeze.' }] }

  it('starts closed with what the row itself carries, and keeps what was read for the question it still asks', () => {
    assert.deepEqual(backgroundFor(null, first), { version: questionVersion(first), open: false, items: undefined })
    assert.deepEqual(backgroundFor(null, asking('Which database?', { background: [{ text: 'Postgres is in use.' }] })).items, [{ text: 'Postgres is in use.' }])
    assert.equal(backgroundFor(read, first), read)
    assert.equal(backgroundFor(read, { ...first }), read)
  })
  it('drops what was read for the old question when a live update asks another', () => {
    const second = asking('Which database?', { hasBackground: true })
    assert.deepEqual(backgroundFor(read, second), { version: questionVersion(second), open: false, items: undefined })
  })
  it('drops it too when the same words come back from a later version of the request', () => {
    const later = asking('Ship on Friday or Monday?', { detailRevision: 'r2', background: [{ text: 'Monday is a holiday.' }] })
    assert.deepEqual(backgroundFor(read, later), { version: questionVersion(later), open: false, items: [{ text: 'Monday is a holiday.' }] })
  })
  it('never shows a read that comes back after the question changed: it is kept under the question it was started for', () => {
    const second = asking('Which database?', { hasBackground: true })
    // The read was started on the first question and lands once the row asks the second.
    const late: KeptBackground = { version: questionVersion(first), open: true, items: [{ text: 'Friday is the freeze.' }] }
    assert.equal(backgroundFor(late, second).open, false)
    assert.equal(backgroundFor(late, second).items, undefined)
    // A failed read for the old question is not this question's error either.
    assert.equal(backgroundFor({ version: questionVersion(first), open: true, items: [], error: 'offline' }, second).error, undefined)
  })
  it('tells questions apart by their words and the request\'s version, and a row with no question from one with any', () => {
    assert.notEqual(questionVersion(first), questionVersion(asking('Which database?')))
    assert.notEqual(questionVersion(first), questionVersion(asking('Ship on Friday or Monday?', { detailRevision: 'r2' })))
    assert.notEqual(questionVersion({}), questionVersion(asking('')))
    assert.equal(questionVersion(first), questionVersion(asking('Ship on Friday or Monday?')))
  })
})

describe('how the last answer fared, on the row and the request page', () => {
  const asks: Request['next'] = { who: 'human', need: 'answer', text: 'Pick one' }
  const working: Request['next'] = { who: 'bot', text: 'Remove the other draft' }
  const reviewing: Request['next'] = { who: 'human', need: 'review', text: 'Check it' }

  it('says nothing for a request no answer was sent to', () => {
    assert.equal(answerDelivery({ next: asks }, undefined), null)
    assert.equal(answerDelivery({ next: working }, 'Linear.'), null)
  })
  it('a failed delivery stays said after the request stops asking, with the reason and the answer that was sent', () => {
    const failed = { state: 'failed' as const, error: 'Codex exited before it took your answer.' }
    for (const next of [working, reviewing, asks]) {
      assert.deepEqual(answerDelivery({ answer: failed, next }, 'Keep the linear forecast.'), { ...failed, text: 'Keep the linear forecast.' })
    }
    // Sent from another window, or before a reload: the failure is still said, with no text to copy.
    assert.deepEqual(answerDelivery({ answer: failed, next: working }, undefined), failed)
    assert.deepEqual(answerDelivery({ answer: { state: 'failed' }, next: working }, undefined), { state: 'failed' })
  })
  it('an answer on its way is said whether or not the question still stands', () => {
    assert.deepEqual(answerDelivery({ answer: { state: 'answering' }, next: working }, 'Linear.'), { state: 'answering', text: 'Linear.' })
    assert.deepEqual(answerDelivery({ answer: { state: 'answering' }, next: asks }, undefined), { state: 'answering' })
  })
  it('a delivered answer is said beside the question it was sent to, and clears once the request moves on', () => {
    assert.deepEqual(answerDelivery({ answer: { state: 'delivered' }, next: asks }, 'Linear.'), { state: 'delivered' })
    assert.equal(answerDelivery({ answer: { state: 'delivered' }, next: working }, 'Linear.'), null)
    assert.equal(answerDelivery({ answer: { state: 'delivered' }, next: reviewing }, undefined), null)
  })
})

describe('the answers this page sent', () => {
  const sent = { r5: 'Linear.', r6: 'Monthly only.' }
  it('are kept while their delivery is on its way or failed', () => {
    const requests = [{ id: 'r5', answer: { state: 'answering' as const } }, { id: 'r6', answer: { state: 'failed' as const, error: 'exit 1' } }]
    assert.equal(keptSentAnswers(sent, requests), sent)
    // The model that arrives before the worker has recorded the run still has no answer on the request.
    assert.equal(keptSentAnswers(sent, [{ id: 'r5' }, { id: 'r6' }]), sent)
  })
  it('are dropped once delivered, or once their request is gone', () => {
    assert.deepEqual(keptSentAnswers(sent, [{ id: 'r5', answer: { state: 'delivered' as const } }, { id: 'r6', answer: { state: 'failed' as const } }]), { r6: 'Monthly only.' })
    assert.deepEqual(keptSentAnswers(sent, [{ id: 'r5', answer: { state: 'answering' as const } }]), { r5: 'Linear.' })
    assert.deepEqual(keptSentAnswers(sent, []), {})
  })
})
