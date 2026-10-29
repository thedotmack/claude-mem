// Shared focus pages from the viewer (R17): which areas are shared, sharing and stopping, the comments, and keeping
// each shared page current. The local worker signs every cmem.ai call (WorkViewRoutes /api/work-view/focus/share*),
// so the cloud sync credential never reaches this page.
//
// Publishing runs while My Work is open on one of the owner's machines: each model the screen gets is turned into
// the shared page for every shared area and sent, at most every few seconds. The worker skips pages that have not
// changed.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { toSharedFocusPage } from './to-shared-focus.ts'
import type { WorkModel } from './work-data-source.ts'

export interface FocusShare { url: string; sharedAt: string; publishedAt: string | null }
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
  /** Why the last publish of an area failed, by area id. */
  publishErrors: Record<string, string>
}

let state: State = { loaded: false, connected: false, shares: {}, publishErrors: {} }
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }

export function useFocusShares(): State {
  return useSyncExternalStore(subscribe, () => state)
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

/** Reads which areas this install shares. Quiet when the worker is older and has no sharing routes. */
export async function loadFocusShares(): Promise<void> {
  try {
    const answer = await call<{ connected: boolean; shares: Record<string, FocusShare> }>('/api/work-view/focus/shares')
    set({ loaded: true, connected: answer.connected, shares: answer.shares ?? {} })
  } catch {
    set({ loaded: true, connected: false, shares: {} })
  }
}

/** A link that stopped working elsewhere (another machine, or on cmem.ai) is forgotten here too. */
function forget(focusAreaId: string) {
  const { [focusAreaId]: _gone, ...shares } = state.shares
  set({ shares })
}

async function publish(model: WorkModel, focusAreaId: string): Promise<FocusShare> {
  const page = toSharedFocusPage(model, focusAreaId, Date.now())
  if (!page) throw new Error('This area can’t be shared: share a kept or done focus area.')
  try {
    const answer = await call<FocusShare & { sent: boolean }>('/api/work-view/focus/share', { method: 'POST', body: { focusAreaId, page } })
    const share = { url: answer.url, sharedAt: answer.sharedAt, publishedAt: answer.publishedAt }
    const { [focusAreaId]: _cleared, ...publishErrors } = state.publishErrors
    set({ shares: { ...state.shares, [focusAreaId]: share }, publishErrors })
    return share
  } catch (error) {
    if ((error as { status?: number }).status === 410) forget(focusAreaId)
    else set({ publishErrors: { ...state.publishErrors, [focusAreaId]: (error as Error).message } })
    throw error
  }
}

/** Shares the area: cmem.ai answers with its link, and the page goes up at once. */
export const shareFocusArea = (model: WorkModel, focusAreaId: string) => publish(model, focusAreaId)

export async function stopSharingFocusArea(focusAreaId: string): Promise<void> {
  await call('/api/work-view/focus/share/stop', { method: 'POST', body: { focusAreaId } })
  forget(focusAreaId)
}

export async function readFocusShareComments(focusAreaId: string): Promise<FocusShareComment[]> {
  try {
    const answer = await call<{ comments: FocusShareComment[] }>(`/api/work-view/focus/share/comments?focusAreaId=${encodeURIComponent(focusAreaId)}`)
    return answer.comments
  } catch (error) {
    if ((error as { status?: number }).status === 410) forget(focusAreaId)
    throw error
  }
}

export async function postFocusShareComment(focusAreaId: string, body: string): Promise<FocusShareComment> {
  const answer = await call<{ comment: FocusShareComment }>('/api/work-view/focus/share/comments', { method: 'POST', body: { focusAreaId, body } })
  return answer.comment
}

/** At most one publish round this often: a busy feed still updates the page, and a quiet one sends right away. */
export const PUBLISH_EVERY_MS = 5000

/**
 * Keeps every shared area's page current from the live model. Only on the local worker: the sample has nothing
 * real to share. A failed publish is shown in the share dialog and tried again with the next change.
 */
export function useFocusSharePublisher(model: WorkModel): void {
  const { loaded, shares } = useFocusShares()
  const live = model.sourceKind === 'local'
  useEffect(() => { if (live && !loaded) void loadFocusShares() }, [live, loaded])
  const latest = useRef(model)
  useEffect(() => { latest.current = model }, [model])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRound = useRef(0)
  const sharedIds = Object.keys(shares).sort().join('\n')
  useEffect(() => {
    if (!live || !sharedIds || timer.current) return
    // Trailing: the round reads the newest model when it runs, so changes that arrive while it waits are included.
    timer.current = setTimeout(() => {
      timer.current = null
      lastRound.current = Date.now()
      for (const focusAreaId of sharedIds.split('\n')) void publish(latest.current, focusAreaId).catch(() => { /* shown in the dialog */ })
    }, Math.max(0, lastRound.current + PUBLISH_EVERY_MS - Date.now()))
  }, [live, model, sharedIds])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
}
