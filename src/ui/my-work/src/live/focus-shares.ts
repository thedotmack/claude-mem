// Shared focus pages from the viewer (R17): which areas are shared, sharing and stopping, and the comments. The local
// worker builds and publishes each page and signs every cmem.ai call (WorkViewRoutes /api/work-view/focus/share*,
// src/services/work-view/focus-share-publisher.ts), so the pages keep updating with My Work closed and the cloud sync
// credential never reaches this page.
import { useEffect, useSyncExternalStore } from 'react'

export interface FocusShare {
  url: string
  sharedAt: string
  publishedAt: string | null
  /** Why the worker's last update of the page didn't go through, if it didn't. */
  publishError: string | null
}
export interface FocusShareComment {
  id: string
  authorKind: 'person' | 'agent'
  authorName: string
  agentName: string | null
  isOwner: boolean
  body: string
  createdAt: string
}

interface State {
  /** False until the worker answered; then whether cloud sync is connected. */
  loaded: boolean
  connected: boolean
  shares: Record<string, FocusShare>
  /**
   * How many comments each shared area's page has, from the last comments read that answered (the shared mark's count,
   * c-share-focus M3). An area missing here has had no read answer yet, so its mark shows no number.
   */
  commentCounts: Record<string, number>
}

let state: State = { loaded: false, connected: false, shares: {}, commentCounts: {} }
/** Bumped by every share, stop or forget, so a list read that started earlier never overwrites what they did. */
let changes = 0
let nextListRead = 0
let acceptedListRead = 0
/** Apply same-area writes in invocation order, including their responses. Other areas stay independent. */
const writes = new Map<string, Promise<unknown>>()
function inShareOrder<T>(focusAreaId: string, work: () => Promise<T>): Promise<T> {
  const before = writes.get(focusAreaId) ?? Promise.resolve()
  const run = before.then(work, work)
  const settled = run.catch(() => undefined)
  writes.set(focusAreaId, settled)
  void settled.then(() => { if (writes.get(focusAreaId) === settled) writes.delete(focusAreaId) })
  return run
}
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }

/** What My Work knows about shared areas right now. */
export const focusSharesNow = (): State => state

export function useFocusShares(): State {
  return useSyncExternalStore(subscribe, focusSharesNow)
}

/**
 * What answers these calls in the page instead of the worker: the sample's sharing demonstration
 * (live/sample-source.ts, `?source=sample&sample-state=area-shared`), which writes nothing and reaches no worker. Null on
 * the person's own work, where every call goes to the worker.
 */
export type FocusShareAnswerInPage = (url: string, init?: { method: 'POST'; body: unknown }) => Promise<unknown>
let answerInPage: FocusShareAnswerInPage | null = null

/** The sample demonstration answers the calls from now on (sample-source.ts); `null` gives them back to the worker. */
export function answerFocusShareCallsInPage(answer: FocusShareAnswerInPage | null): void {
  answerInPage = answer
}

/** Whether the sharing calls are the sample's demonstration: sharing then works on the sample page too. */
export const focusSharesAreADemonstration = (): boolean => answerInPage !== null

async function call<T>(url: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  if (answerInPage) return await answerInPage(url, init) as T
  const response = await fetch(url, init ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : undefined)
  let answer: unknown = null
  try { answer = await response.json() } catch { /* the status says enough */ }
  if (!response.ok) {
    const reason = (answer as { error?: unknown } | null)?.error
    const error = new Error(typeof reason === 'string' ? reason : `The worker answered ${response.status}.`) as Error & { status: number }
    error.status = response.status
    throw error
  }
  return answer as T
}

/**
 * Reads which areas this install shares. Quiet when the worker is older and has no sharing routes; a failed read
 * keeps what was read before, and the next read tries again.
 */
export async function loadFocusShares(): Promise<void> {
  const startedAt = changes
  const reading = ++nextListRead
  try {
    const answer = await call<{ connected: boolean; shares: Record<string, FocusShare> }>('/api/work-view/focus/shares')
    if (startedAt !== changes || reading < acceptedListRead) return
    acceptedListRead = reading
    set({ loaded: true, connected: answer.connected, shares: answer.shares ?? {} })
  } catch {
    set({ loaded: true })
  }
}

/** A link that stopped working elsewhere (another machine, or on cmem.ai) is forgotten here too. */
function forget(focusAreaId: string) {
  changes++
  const { [focusAreaId]: _gone, ...shares } = state.shares
  const { [focusAreaId]: _count, ...commentCounts } = state.commentCounts
  set({ shares, commentCounts })
}

/** Shares the area: the worker builds the page, cmem.ai answers with its link, and the page goes up at once. */
export function shareFocusArea(focusAreaId: string): Promise<FocusShare> {
  return inShareOrder(focusAreaId, async () => {
    const answer = await call<Omit<FocusShare, 'publishError'> & { sent: boolean }>('/api/work-view/focus/share', { method: 'POST', body: { focusAreaId } })
    const share = { url: answer.url, sharedAt: answer.sharedAt, publishedAt: answer.publishedAt, publishError: null }
    changes++
    set({ shares: { ...state.shares, [focusAreaId]: share } })
    return share
  })
}

export function stopSharingFocusArea(focusAreaId: string): Promise<void> {
  return inShareOrder(focusAreaId, async () => {
    await call('/api/work-view/focus/share/stop', { method: 'POST', body: { focusAreaId } })
    forget(focusAreaId)
  })
}

export async function readFocusShareComments(focusAreaId: string): Promise<FocusShareComment[]> {
  // The link this read asks about. Sharing again after a stop makes a new link (the worker's focus-share.ts stop), so
  // an answer speaks for the area only while the area still has this link.
  const readLink = state.shares[focusAreaId]?.url
  const stillTheLinkRead = () => readLink !== undefined && state.shares[focusAreaId]?.url === readLink
  try {
    const answer = await call<{ comments: FocusShareComment[] }>(`/api/work-view/focus/share/comments?focusAreaId=${encodeURIComponent(focusAreaId)}`)
    // The mark beside the area's name counts them. A read that answered after a stop leaves no count behind, and one
    // that answered after a stop and a new share leaves the new link's mark alone.
    if (stillTheLinkRead()) set({ commentCounts: { ...state.commentCounts, [focusAreaId]: answer.comments.length } })
    return answer.comments
  } catch (error) {
    if (stillTheLinkRead()) {
      // cmem.ai says this link stopped working (stopped on another machine or on cmem.ai): it is forgotten here too.
      if ((error as { status?: number }).status === 410) forget(focusAreaId)
      // The count is not known now: the mark drops its number rather than show an old one as if it were current.
      else if (focusAreaId in state.commentCounts) {
        const { [focusAreaId]: _unknown, ...commentCounts } = state.commentCounts
        set({ commentCounts })
      }
    }
    throw error
  }
}

export async function postFocusShareComment(focusAreaId: string, body: string): Promise<FocusShareComment> {
  const answer = await call<{ comment: FocusShareComment }>('/api/work-view/focus/share/comments', { method: 'POST', body: { focusAreaId, body } })
  return answer.comment
}

/** How often My Work re-reads which areas are shared: a failed read, or cloud sync connected from Setup, catches up. */
export const SHARES_REFRESH_MS = 60_000

/**
 * How often the shared mark re-reads its comment count. Each read is one request the worker signs and sends to cmem.ai,
 * a hosted service outside this computer, so a glance at a count asks it once a minute per shared area on screen (load
 * on the outside service, kept as low as the shares list's own read, SHARES_REFRESH_MS); the open dialog reads every
 * 20 s for someone who is following the comments (share-focus.tsx COMMENTS_REFRESH_MS).
 */
export const COMMENT_COUNT_REFRESH_MS = 60_000

/**
 * The number of comments on a shared area's page, for its mark (c-share-focus M3): read when the mark first shows and
 * every COMMENT_COUNT_REFRESH_MS, and by every read the open dialog makes. Null until a read answers, and again after a
 * read fails (readFocusShareComments drops the count it cannot vouch for); the dialog's comments section says why, with
 * Try again.
 */
export function useFocusShareCommentCount(focusAreaId: string, shared: boolean): number | null {
  const count = useFocusShares().commentCounts[focusAreaId]
  useEffect(() => {
    if (!shared) return
    // The mark has no room to say why; the console does, and the dialog shows it with Try again (share-focus.tsx).
    const read = () => void readFocusShareComments(focusAreaId).catch((error: unknown) => {
      console.warn(`[my-work] Could not count the comments on the shared page of focus area ${focusAreaId}; its mark shows no number until a read answers:`, error)
    })
    const first = setTimeout(read, 0)
    const timer = setInterval(read, COMMENT_COUNT_REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [focusAreaId, shared])
  return count ?? null
}

/** Reads which areas are shared while My Work shows live work, for the Shared mark beside each area's name. */
export function useFocusSharesLoader(live: boolean): void {
  useEffect(() => {
    if (!live) return
    const first = setTimeout(() => void loadFocusShares(), 0)
    const timer = setInterval(() => void loadFocusShares(), SHARES_REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [live])
}
