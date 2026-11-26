import type {
  ReviewStackAction, ReviewStackImportCard, ReviewStackImportResult, ReviewStackPage, ReviewStackSnapshot,
} from '../../../../shared/review-stack.ts'

export const REVIEW_STACK_URL = '/api/work-view/review-stack'

export class ReviewStackHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const data = body && typeof body === 'object' ? body as { error?: unknown; message?: unknown } : null
    const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `Review Stack returned ${response.status}.`
    throw new ReviewStackHttpError(response.status, message)
  }
  return response.json() as Promise<T>
}

/** Each cursor reads the same revision. Never combine pages from two versions of the owner's deck. */
async function readPages(signal: AbortSignal, send: typeof fetch): Promise<ReviewStackSnapshot> {
  const cursors = new Set<string>()
  let cursor: string | null = null
  let snapshot: ReviewStackSnapshot | undefined
  do {
    const url: string = cursor ? `${REVIEW_STACK_URL}?cursor=${encodeURIComponent(cursor)}` : REVIEW_STACK_URL
    const page: ReviewStackPage = await json<ReviewStackPage>(await send(url, { signal, cache: 'no-store', credentials: 'same-origin' }))
    if (!Array.isArray(page.cards) || !Array.isArray(page.reviews) || !Array.isArray(page.bookmarks) || !Array.isArray(page.followUps) || !Array.isArray(page.groups) || typeof page.revision !== 'string') {
      throw new Error('Could not read the cards in this Review Stack.')
    }
    if (!snapshot) snapshot = { revision: page.revision, cards: [], reviews: [], bookmarks: [], followUps: [], groups: [] }
    if (page.revision !== snapshot.revision) throw new ReviewStackHttpError(409, 'Your Review Stack changed while loading.')
    snapshot.cards.push(...page.cards)
    snapshot.reviews.push(...page.reviews)
    snapshot.bookmarks.push(...page.bookmarks)
    snapshot.followUps.push(...page.followUps)
    snapshot.groups.push(...page.groups)
    cursor = page.nextCursor
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('Could not read the next page of cards.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return snapshot!
}

export async function readReviewStack(signal: AbortSignal, send: typeof fetch = fetch): Promise<ReviewStackSnapshot> {
  try { return await readPages(signal, send) } catch (error) {
    if (signal.aborted || !(error instanceof ReviewStackHttpError) || error.status !== 409) throw error
    return readPages(signal, send)
  }
}

async function post<T>(path: string, body: unknown, key: string, send: typeof fetch) {
  return json<T>(await send(`${REVIEW_STACK_URL}/${path}`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
  }))
}

export function sendReviewAction(action: ReviewStackAction, key: string, send: typeof fetch = fetch) {
  return post<{ ok: true }>('action', action, key, send)
}

export function sendReviewCards(cards: ReviewStackImportCard[], key: string, send: typeof fetch = fetch) {
  return post<ReviewStackImportResult>('import', { cards }, key, send)
}

export function originalHttps(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href
  } catch { /* A local path or old placeholder has no shareable original link. */ }
  return undefined
}
