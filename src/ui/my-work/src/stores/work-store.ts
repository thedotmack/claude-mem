import { createStore } from 'zustand/vanilla'
import type { ConnectionStatus } from '../live/connection-status.ts'
import { freshlyUpdatedRequestIds } from '../live/update-queue.ts'
import type { WorkDataSource, WorkModel } from '../live/work-data-source.ts'

export type WorkModelLoad =
  | { state: 'loading' }
  | { state: 'loaded'; model: WorkModel }
  | { state: 'failed'; error: string }

interface WorkState {
  load: WorkModelLoad
  connection: ConnectionStatus | null
  freshlyUpdatedIds: ReadonlySet<string>
  source: WorkDataSource | null
  sessionId: number
  refreshing: boolean
  refreshError: string | null
  receiveModel: (model: WorkModel) => void
  receiveConnection: (connection: ConnectionStatus) => void
  start: (source: WorkDataSource) => () => void
  refresh: () => Promise<void>
}

const sameConnection = (a: ConnectionStatus | null, b: ConnectionStatus) =>
  a !== null && a.state === b.state && a.label === b.label && a.detail === b.detail && a.tooltip === b.tooltip

/** One source session owns the stream, reads and timers. Disposed sessions cannot publish into a new one. */
export function createWorkStore() {
  let session = 0
  let revision = 0
  let read = 0
  let stop: (() => void) | undefined
  let freshTimer: ReturnType<typeof setTimeout> | undefined

  return createStore<WorkState>()((set, get) => ({
    load: { state: 'loading' },
    connection: null,
    freshlyUpdatedIds: new Set(),
    source: null,
    sessionId: 0,
    refreshing: false,
    refreshError: null,
    receiveModel: (model) => {
      const previous = get().load
      const changed = new Set(freshlyUpdatedRequestIds(previous.state === 'loaded' ? previous.model.requests : [], model.requests))
      if (changed.size > 0) {
        clearTimeout(freshTimer)
        freshTimer = setTimeout(() => set({ freshlyUpdatedIds: new Set() }), 4000)
      }
      revision++
      set({
        load: { state: 'loaded', model },
        connection: model.connection,
        refreshError: null,
        ...(changed.size > 0 ? { freshlyUpdatedIds: changed } : {}),
      })
    },
    // A heartbeat updates only the indicator subscribers, not every request card and open editor.
    receiveConnection: (connection) => {
      if (!sameConnection(get().connection, connection)) set({ connection })
    },
    refresh: async () => {
      const { source, load } = get()
      if (!source) return
      const thisSession = session
      const thisRead = ++read
      const beforeRead = revision
      set({ refreshing: true, refreshError: null, ...(load.state === 'failed' ? { load: { state: 'loading' } as WorkModelLoad } : {}) })
      try {
        const model = await source.loadWorkModel()
        if (session !== thisSession || read !== thisRead || revision !== beforeRead) return
        get().receiveModel(model)
      } catch (reason) {
        if (session !== thisSession || read !== thisRead || revision !== beforeRead) return
        const error = reason instanceof Error ? reason.message : String(reason)
        if (get().load.state === 'loaded') set({ refreshError: error })
        else set({ load: { state: 'failed', error }, refreshError: error })
      } finally {
        if (session === thisSession && read === thisRead) set({ refreshing: false })
      }
    },
    start: (source) => {
      stop?.()
      const thisSession = ++session
      const previousSource = get().source
      set({ source, sessionId: thisSession, ...(previousSource && previousSource !== source ? { load: { state: 'loading' } as WorkModelLoad, connection: null, freshlyUpdatedIds: new Set() } : {}) })
      const unsubscribe = source.subscribeToLiveUpdates(
        (model) => { if (session === thisSession) get().receiveModel(model) },
        (connection) => { if (session === thisSession) get().receiveConnection(connection) },
      )
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        unsubscribe()
        if (session === thisSession) {
          session++
          clearTimeout(freshTimer)
          set({ sessionId: session, refreshing: false, freshlyUpdatedIds: new Set() })
          stop = undefined
        }
      }
      stop = dispose
      void get().refresh()
      return dispose
    },
  }))
}

export const workStore = createWorkStore()
