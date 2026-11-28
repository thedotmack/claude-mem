// The one My Work store in the browser. Components read it with `useStore.use.<key>()` or `useStore(selector)`;
// everything outside React reads `useStore.getState()`.
import { useShallow } from 'zustand/react/shallow'
import type { Agent, Device } from '@/data'
import type { ConnectionStatus } from '@/live/connection-status'
import { sharedViewerOwner } from '@/live/shared-viewer-session'
import { localSource } from '@/live/local-source'
import { sampleSourceAtThisAddress } from '@/live/sample-source'
import { isServedFromCloud } from '@/live/served-from'
import { sendHostedUsage, sendUsageReport } from '@/live/usage'
import type { WorkDataSource, WorkModel } from '@/live/work-data-source'
import { createBoundStore, PREFERENCES_STORAGE_KEY } from './create-store'
import { createSelectors } from './create-selectors'
import type { StoreEnvironment, Workspace } from './store-types'

/**
 * `?source=sample` shows the fixtures (with `&sample-state=reply-card`, a reply card that can be tried, as a demonstration:
 * sampleSourceAtThisAddress); otherwise the local worker (through the dev proxy, or same origin when the worker serves
 * this page). Never falls back to sample data.
 */
const sharedOwner = sharedViewerOwner()
export const ACTIVE_SOURCE: WorkDataSource = !sharedOwner && new URLSearchParams(window.location.search).get('source') === 'sample' ? sampleSourceAtThisAddress() : localSource

/**
 * Where the display preferences are saved. persist writes on every state change, live models included, so a value
 * that is already saved is not written again. localStorage can throw (blocked site data); preferences then last only
 * for this visit.
 */
function browserStorage(): StoreEnvironment['storage'] {
  let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  try {
    storage = window.localStorage
    storage.getItem(PREFERENCES_STORAGE_KEY)
  } catch {
    const visit = new Map<string, string>()
    storage = { getItem: (key) => visit.get(key) ?? null, setItem: (key, value) => { visit.set(key, value) }, removeItem: (key) => { visit.delete(key) } }
  }
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => { if (storage.getItem(key) !== value) storage.setItem(key, value) },
    removeItem: (key) => storage.removeItem(key),
  }
}

/** What this page keeps in a history entry's state: the entry's id, and where it was left scrolled when it was written. */
interface EntryState { entryId?: unknown; scrollY?: unknown }

/**
 * Where the entry shown was left scrolled when this page's document went away (a reload, a link to another site):
 * history.state cannot be written then (Chrome keeps no change made while the page hides), so it waits in the tab's
 * sessionStorage for the next document. One record, replaced each time.
 */
const LEFT_DOCUMENT_STORAGE_KEY = 'claude-mem:my-work:left-scrolled'

/**
 * The page's history entries, and where the person left each one scrolled, so Back, Forward and a reload land there
 * again (design pass Phase 3). The app restores the position itself (`scrollRestoration = 'manual'`) once the page it
 * lands on is tall enough (App.tsx, lib/scroll-ask.ts): the browser's own restore ran while that page was still being
 * drawn. Each entry carries an id in history.state and positions are kept by id, because after Back or Forward the
 * entry the person left can no longer be written. A push also writes the position into the entry it leaves, so a new
 * document of this page finds it there; the entry shown when the document goes away keeps it in sessionStorage.
 */
function browserHistory() {
  window.history.scrollRestoration = 'manual'
  // Unique across this tab's documents: a reload starts the count again, with a new start time.
  let entries = 0
  const newEntryId = () => `${performance.timeOrigin}:${++entries}`
  const stateOf = (): EntryState => (window.history.state ?? {}) as EntryState
  /** Where each entry this document showed was left scrolled: one number per entry visited. */
  const leftScrolledAt = new Map<string, number>()
  const entryIdNow = stateOf().entryId
  let current = typeof entryIdNow === 'string' ? entryIdNow : newEntryId()
  const writeEntry = (scrolled: boolean) => window.history.replaceState({ ...stateOf(), entryId: current, ...(scrolled ? { scrollY: window.scrollY } : {}) }, '')
  writeEntry(false)
  // sessionStorage can throw (blocked site data); positions then last only while this document does.
  try {
    const left: unknown = JSON.parse(window.sessionStorage.getItem(LEFT_DOCUMENT_STORAGE_KEY) ?? 'null')
    const { entryId, scrollY } = (left ?? {}) as EntryState
    if (entryId === current && typeof scrollY === 'number') leftScrolledAt.set(current, scrollY)
  } catch { /* no position from the last document */ }
  window.addEventListener('pagehide', () => {
    try { window.sessionStorage.setItem(LEFT_DOCUMENT_STORAGE_KEY, JSON.stringify({ entryId: current, scrollY: window.scrollY })) } catch { /* see above */ }
  })
  return {
    writeUrl: (url: URL, replace: boolean) => {
      if (replace) { window.history.replaceState(window.history.state, '', url); return }
      leftScrolledAt.set(current, window.scrollY)
      writeEntry(true)
      current = newEntryId()
      window.history.pushState({ entryId: current }, '', url)
    },
    /**
     * Back or Forward showed another entry: the one left keeps where it was scrolled (under `manual` the window has not
     * moved yet), and an entry this page did not make (a link to `#main-content`) gets an id.
     */
    arrived: () => {
      leftScrolledAt.set(current, window.scrollY)
      const id = stateOf().entryId
      current = typeof id === 'string' ? id : newEntryId()
      if (typeof id !== 'string') writeEntry(false)
    },
    savedScrollY: (): number | null => {
      const written = stateOf().scrollY
      return leftScrolledAt.get(current) ?? (typeof written === 'number' ? written : null)
    },
  }
}

const pageHistory = browserHistory()

const useStoreBase = createBoundStore({
  href: () => window.location.href,
  writeUrl: pageHistory.writeUrl,
  storage: browserStorage(),
  // The signed-in shared host records consent-aware milestones on its overview GET.
  // Local workers and the legacy hosted viewer retain their existing usage endpoint.
  reportsUsage: !sharedOwner && ACTIVE_SOURCE === localSource,
  sendUsage: isServedFromCloud(window.location.hostname) ? sendHostedUsage : sendUsageReport,
  scrollToTop: () => window.scrollTo(0, 0),
  savedScrollY: pageHistory.savedScrollY,
})

export const useStore = createSelectors(useStoreBase)
window.addEventListener('popstate', () => {
  pageHistory.arrived()
  useStore.getState().showUrl()
})

function currentWorkModel(): WorkModel {
  const load = useStore.getState().work.load
  if (load.state !== 'loaded') throw new Error(`Work model read before it loaded (${load.state})`)
  return load.model
}

/** The active source's model, re-rendering when it changes. Only valid once App has a loaded model. */
export function useWorkModel(): WorkModel {
  const load = useStore((state) => state.work.load)
  if (load.state !== 'loaded') throw new Error(`useWorkModel() before the work model loaded (${load.state})`)
  return load.model
}

/** The feed's health; a heartbeat re-renders only what reads this. */
export function useConnection(): ConnectionStatus {
  const connection = useStore((state) => state.work.connection)
  if (!connection) throw new Error('useConnection() before the work model loaded')
  return connection
}

/** True for a few seconds after this request's recorded content changed. */
export const useFreshlyUpdated = (requestId: string) => useStore((state) => state.work.freshlyUpdatedIds.has(requestId))

/** What changed in the models this screen showed, newest first (update-queue.ts). */
export const useRecentChanges = () => useStore((state) => state.work.recentChanges)

/** Where the work is seen: in sample mode the wireframe's switch, otherwise the source (the local worker is at home, cmem.ai on the go). */
export function useWorkspace(): Workspace {
  return useStore(useShallow((state) => {
    const { mode, team, connected } = state.view.workspace
    const { sourceKind } = state.work
    return { mode: sourceKind === 'sample' || sourceKind === null ? mode : sourceKind === 'cloud' ? 'web' : 'home', team, connected }
  }))
}

export const requestById = (id: string) => currentWorkModel().requests.find((request) => request.id === id) ?? null

/** Looks up an agent in the active model. Fails fast: every request's agent is in its model. */
export function agentById(id: string): Agent {
  const agent = currentWorkModel().agents.find((entry) => entry.id === id)
  if (!agent) throw new Error(`No agent ${id}`)
  return agent
}
export function deviceById(id: string): Device {
  const device = currentWorkModel().devices.find((entry) => entry.id === id)
  if (!device) throw new Error(`No device ${id}`)
  return device
}

export type * from './store-types'
