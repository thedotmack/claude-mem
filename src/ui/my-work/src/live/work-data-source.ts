// The one boundary between the screens and where work comes from (plan: "The adapter decision").
// Screens consume a WorkModel and never see API shapes. Implementations: sampleSource (fixtures) and
// localSource (the worker at localhost:37777); cloudSource (cmem.ai) comes later.
import type { Agent, Device, Request } from '../data.ts'
import type { ConnectionStatus } from './connection-status.ts'
import type { ReviewResult } from './review-response.ts'

export type SourceKind = 'sample' | 'local' | 'cloud'

/** A request the mapper could not read consistently. It renders as its own card instead of breaking the page. */
export interface RequestReadError { requestId: string; title: string | null; reason: string; evidenceHref: string | null }

export interface WorkModel {
  sourceKind: SourceKind
  requests: Request[]
  requestReadErrors: RequestReadError[]
  agents: Agent[]
  devices: Device[]
  /** Who asked, for the Team board. Solo mode: only you. */
  people: string[]
  unlinkedWorkCount: number
  /** The backend's own health. `connected: false` means it answered but could not read saved work. */
  sourceHealth: { connected: boolean; error: string | null }
  /** The live feed's health (getConnectionStatus). Only SSE messages renew "live"; an HTTP read never does. */
  connection: ConnectionStatus
}

/** What the pure mapper produces; the source adds the connection it measured. */
export type MappedWorkModel = Omit<WorkModel, 'connection'>

export interface WorkDataSource {
  readonly sourceKind: SourceKind
  loadWorkModel(): Promise<WorkModel>
  /** Streams new models and connection changes until the returned function is called. */
  subscribeToLiveUpdates(onWorkModel: (model: WorkModel) => void, onConnectionChange: (status: ConnectionStatus) => void): () => void
  /**
   * Marks one version of a request checked, or undoes that. `expectedFingerprint` is the version on screen: the
   * worker refuses a check for any other version. Rejects when the save fails for a reason it can't name.
   */
  setRequestChecked(requestId: string, expectedFingerprint: string, checked: boolean): Promise<ReviewResult>
}
