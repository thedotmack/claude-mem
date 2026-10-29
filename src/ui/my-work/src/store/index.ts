// The one My Work store in the browser. Components read it with `useStore.use.<key>()` or `useStore(selector)`;
// everything outside React reads `useStore.getState()`.
import { useShallow } from 'zustand/react/shallow'
import type { Agent, Device } from '@/data'
import type { ConnectionStatus } from '@/live/connection-status'
import { localSource } from '@/live/local-source'
import { sampleSource } from '@/live/sample-source'
import { sendUsageReport } from '@/live/usage'
import type { WorkDataSource, WorkModel } from '@/live/work-data-source'
import { createBoundStore } from './create-store'
import { createSelectors } from './create-selectors'
import type { StoreEnvironment, Workspace } from './store-types'

/** `?source=sample` shows the fixtures; otherwise the local worker (through the dev proxy, or same origin when the worker serves this page). Never falls back to sample data. */
export const ACTIVE_SOURCE: WorkDataSource = new URLSearchParams(window.location.search).get('source') === 'sample' ? sampleSource : localSource

/**
 * Where the display preferences are saved. persist writes on every state change, live models included, so a value
 * that is already saved is not written again. localStorage can throw (blocked site data); preferences then last only
 * for this visit.
 */
function browserStorage(): StoreEnvironment['storage'] {
  let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  try {
    storage = window.localStorage
    storage.getItem('claude-mem:my-work:preferences')
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

const useStoreBase = createBoundStore({
  href: () => window.location.href,
  writeUrl: (url, replace) => replace ? window.history.replaceState(null, '', url) : window.history.pushState(null, '', url),
  prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  storage: browserStorage(),
  reportsUsage: ACTIVE_SOURCE === localSource,
  sendUsage: sendUsageReport,
  scrollToTop: () => window.scrollTo(0, 0),
})

export const useStore = createSelectors(useStoreBase)
window.addEventListener('popstate', () => useStore.getState().showUrl())

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
