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
}

let state: State = { loaded: false, connected: false, shares: {} }
/** Bumped by every share, stop or forget, so a list read that started earlier never overwrites what they did. */
let changes = 0
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }

/** What My Work knows about shared areas right now. */
export const focusSharesNow = (): State => state

export function useFocusShares(): State {
  return useSyncExternalStore(subscribe, focusSharesNow)
}

async function call<T>(url: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
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
  try {
    const answer = await call<{ connected: boolean; shares: Record<string, FocusShare> }>('/api/work-view/focus/shares')
    if (startedAt !== changes) return
    set({ loaded: true, connected: answer.connected, shares: answer.shares ?? {} })
  } catch {
    set({ loaded: true })
  }
}

/** A link that stopped working elsewhere (another machine, or on cmem.ai) is forgotten here too. */
function forget(focusAreaId: string) {
  changes++
  const { [focusAreaId]: _gone, ...shares } = state.shares
  set({ shares })
}

/** Shares the area: the worker builds the page, cmem.ai answers with its link, and the page goes up at once. */
export async function shareFocusArea(focusAreaId: string): Promise<FocusShare> {
  const answer = await call<Omit<FocusShare, 'publishError'> & { sent: boolean }>('/api/work-view/focus/share', { method: 'POST', body: { focusAreaId } })
  const share = { url: answer.url, sharedAt: answer.sharedAt, publishedAt: answer.publishedAt, publishError: null }
  changes++
  set({ shares: { ...state.shares, [focusAreaId]: share } })
  return share
}

export async function stopSharingFocusArea(focusAreaId: string): Promise<void> {
  await call('/api/work-view/focus/share/stop', { method: 'POST', body: { focusAreaId } })
  forget(focusAreaId)
}

export async function readFocusShareComments(focusAreaId: string): Promise<FocusShareComment[]> {
  const startedAt = changes
  try {
    const answer = await call<{ comments: FocusShareComment[] }>(`/api/work-view/focus/share/comments?focusAreaId=${encodeURIComponent(focusAreaId)}`)
    return answer.comments
  } catch (error) {
    // A link stopped and shared again while this read was out is a new link: the old one's 410 leaves it alone.
    if ((error as { status?: number }).status === 410 && startedAt === changes) forget(focusAreaId)
    throw error
  }
}

export async function postFocusShareComment(focusAreaId: string, body: string): Promise<FocusShareComment> {
  const answer = await call<{ comment: FocusShareComment }>('/api/work-view/focus/share/comments', { method: 'POST', body: { focusAreaId, body } })
  return answer.comment
}

/** How often My Work re-reads which areas are shared: a failed read, or cloud sync connected from Setup, catches up. */
export const SHARES_REFRESH_MS = 60_000

/** Reads which areas are shared while My Work shows live work, for the Shared mark beside each area's name. */
export function useFocusSharesLoader(live: boolean): void {
  useEffect(() => {
    if (!live) return
    const first = setTimeout(() => void loadFocusShares(), 0)
    const timer = setInterval(() => void loadFocusShares(), SHARES_REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [live])
}
