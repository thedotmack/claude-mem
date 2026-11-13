// What a thread row shows about answering the agent, apart from the page's own markup (components/thread-list.tsx).
import type { Request } from '../data.ts'

type BackgroundItems = NonNullable<NonNullable<Request['question']>['background']>

/** What the row keeps of "What you may need": whether it is open, and what a detail read brought, for one question. */
export type KeptBackground = { version: string; open: boolean; items?: BackgroundItems; error?: string }

/**
 * Which question a row is asking. A row stays on screen under its request's id while a live update replaces the
 * question, so anything read for a question is kept under this and dropped when it changes: the question's words, and
 * the version of the request's detail the background rides on.
 */
export const questionVersion = (request: Pick<Request, 'question' | 'detailRevision'>): string => JSON.stringify([request.detailRevision ?? null, request.question?.text ?? null])

/**
 * The background to show for the question the row asks now. What was kept for another question is not this one's: the
 * row then starts closed with what its own record carries, and a read that comes back late for the old question (it
 * is kept under the version it was started for) is never shown.
 */
export function backgroundFor(kept: KeptBackground | null, request: Pick<Request, 'question' | 'detailRevision'>): KeptBackground {
  const version = questionVersion(request)
  return kept?.version === version ? kept : { version, open: false, items: request.question?.background }
}

/** How the last answer sent from My Work fared, for as long as the page has something to say about it. */
export type AnswerDelivery = NonNullable<Request['answer']> & { text?: string }

/**
 * What a request says about its last answer's delivery, on the row and on the request page. The delivery and the
 * question are separate facts. Once the tool takes an answer the request stops asking, and the tool can still fail
 * after that, so an answer on its way and one that failed are said whether or not a question still stands. A
 * delivered answer is said only beside the question it was sent to; it clears when the request moves on. `sentText`
 * is the answer this page sent, kept until it is delivered so a failed one can be copied into the chat.
 */
export function answerDelivery(request: Pick<Request, 'answer' | 'next'>, sentText: string | undefined): AnswerDelivery | null {
  const { answer, next } = request
  if (!answer) return null
  if (answer.state === 'delivered') return next.who === 'human' && next.need === 'answer' ? answer : null
  return { ...answer, ...(sentText ? { text: sentText } : {}) }
}

/**
 * The answers this page sent, by request, after `requests` arrived: one is kept until its delivery went through or
 * its request is gone. The same object when nothing is dropped.
 */
export function keptSentAnswers(sent: Readonly<Record<string, string>>, requests: readonly Pick<Request, 'id' | 'answer'>[]): Readonly<Record<string, string>> {
  const waiting = new Set(requests.filter((request) => request.answer?.state !== 'delivered').map((request) => request.id))
  const kept = Object.entries(sent).filter(([requestId]) => waiting.has(requestId))
  return kept.length === Object.keys(sent).length ? sent : Object.fromEntries(kept)
}
