import { presentSync, type SyncPresentation, type SyncStatusForDisplay } from '../../../viewer/utils/sync-presentation.ts'

// Typed copy of claude-mem v15.0.1 plugin/ui/work-view/live-status.js (getConnectionStatus).
// Connection freshness is measured on the browser's monotonic clock. Server
// wall time is displayed as evidence, never used as an agent-presence signal.
export const LOCAL_FEED_STALE_AFTER_MS = 35_000 // Two 15-second heartbeats + margin.
const ACTIVITY_STALE_AFTER_MS = 125_000 // WorkViewRoutes' 120-second activity cache plus one check margin.

export type ConnectionState = 'connecting' | 'reconnecting' | 'stale' | 'unavailable' | 'live'
export type ConnectionTone = 'neutral' | 'warning' | 'positive'

export interface ConnectionStatusInput {
  transportConnected?: boolean
  reconnecting?: boolean
  now: number
  lastEventAt?: number | null
  sourceConnected?: boolean | null
  lastSuccessfulCheckAt?: string | null
  lastSuccessfulCheckReceivedAt?: number | null
  wallNow?: number | null
  staleAfterMs?: number
  /** Where the page is served: the worker on this computer, or the cloud viewer that pulls your synced devices. */
  where?: 'local' | 'cloud'
  sync?: SyncStatusForDisplay | null
  syncReceivedAt?: number | null
  activityCheckedAt?: string | null
  activityAgeAtReceipt?: number | null
  activityReceivedAt?: number | null
}

export interface ConnectionStatus {
  state: ConnectionState
  label: string
  detail: string
  tone: ConnectionTone
  isLive: boolean
  eventAgeMs: number | null
  sourceAgeMs: number | null
  lastSuccessfulCheckAt: string | null
  clockSkew: boolean
  staleAfterMs: number
  tooltip: string
  /** Separately measured upstream synchronization; feed liveness does not imply this is current. */
  sync?: SyncPresentation
}

function age(now: number, at: number | null): number | null {
  if (at === null || !Number.isFinite(now) || !Number.isFinite(at) || now < 0 || at < 0 || at > now + 1000) return null
  return Math.max(0, now - at)
}

function checkTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/**
 * now, lastEventAt and lastSuccessfulCheckReceivedAt use performance.now().
 * Update lastEventAt only for a valid work-view/heartbeat SSE message.
 * Save lastSuccessfulCheckAt (source.lastCheckedAt) and its receipt time only
 * when that payload's source.connected === true: lastCheckedAt also advances
 * on failed backend reads. HTTP snapshots may seed the successful check, but
 * cannot establish that the event feed is live.
 */
export function getConnectionStatus({
  transportConnected = false,
  reconnecting = false,
  now,
  lastEventAt = null,
  sourceConnected = null,
  lastSuccessfulCheckAt = null,
  lastSuccessfulCheckReceivedAt = null,
  wallNow = null,
  staleAfterMs = LOCAL_FEED_STALE_AFTER_MS,
  where = 'local',
  sync = null,
  syncReceivedAt = null,
  activityCheckedAt = null,
  activityAgeAtReceipt = null,
  activityReceivedAt = null,
}: ConnectionStatusInput): ConnectionStatus {
  const cloud = where === 'cloud'
  const feed = cloud ? 'cloud feed' : 'local feed'
  const Feed = cloud ? 'Cloud feed' : 'Local feed'
  const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : LOCAL_FEED_STALE_AFTER_MS
  const eventAgeMs = age(now, lastEventAt)
  const sourceAgeMs = age(now, lastSuccessfulCheckReceivedAt)
  const successfulCheckAt = checkTime(lastSuccessfulCheckAt)
  const clockSkew = successfulCheckAt !== null && wallNow !== null && Number.isFinite(wallNow) && sourceAgeMs !== null
    && Math.abs(wallNow - Date.parse(successfulCheckAt) - sourceAgeMs) > 60_000
  let state: ConnectionState = 'connecting'
  let label = `Connecting to ${feed}`
  let detail = cloud ? 'Waiting for updates synced from your computers.' : 'Waiting for updates from this computer.'
  let tone: ConnectionTone = 'neutral'

  if (!transportConnected) {
    if (reconnecting && eventAgeMs !== null && eventAgeMs > threshold) {
      state = 'stale'; label = `${Feed} stale`; tone = 'warning'
      detail = `Reconnecting to ${cloud ? 'your cloud viewer' : 'this computer'}. No fresh update has arrived; showing the last received work.`
    } else if (reconnecting) {
      state = 'reconnecting'; label = `Reconnecting to ${feed}`; tone = 'warning'
      detail = `Connection interrupted. Showing the last received work while the ${feed} reconnects.`
    }
  } else if (eventAgeMs === null || eventAgeMs > threshold) {
    if (lastEventAt !== null) {
      state = 'stale'; label = `${Feed} stale`; tone = 'warning'
      detail = `${cloud ? 'Cloud' : 'Local'} updates have stopped arriving. Showing the last received work.`
    }
  } else if (sourceConnected === false) {
    state = 'unavailable'; label = `${cloud ? 'Cloud' : 'Local'} source unavailable`; tone = 'warning'
    detail = 'Connected, but saved work cannot be read right now. Showing the last received work.'
  } else if (sourceConnected === true && successfulCheckAt !== null && sourceAgeMs !== null) {
    if (sourceAgeMs > threshold) {
      state = 'stale'; label = `${Feed} stale`; tone = 'warning'
      detail = 'Connected, but the saved work has not been refreshed. Showing the last received work.'
    } else {
      state = 'live'; label = 'Live updates'; tone = 'positive'
      detail = cloud
        ? 'Connected to the cloud viewer. Incoming synchronization is reported separately.'
        : 'Updates are arriving from this computer. Each card shows when its work was last updated.'
    }
  }

  const activityElapsed = age(now, activityReceivedAt)
  const activityAge = activityAgeAtReceipt === null || activityElapsed === null ? null : activityAgeAtReceipt + activityElapsed
  if (state === 'live' && activityCheckedAt !== null && (activityAge === null || activityAge < 0 || !Number.isFinite(activityAge))) {
    state = 'stale'; label = 'Activity freshness unknown'; tone = 'warning'
    detail = 'The feed is connected, but the age of its saved activity could not be confirmed.'
  } else if (state === 'live' && activityAge !== null && activityAge > ACTIVITY_STALE_AFTER_MS) {
    state = 'stale'; label = 'Saved activity stale'; tone = 'warning'
    detail = 'The feed is connected, but its activity projection has not been refreshed. Showing the last received work.'
  }
  const tooltip = `Last successful ${cloud ? 'cloud' : 'local'} check: ${successfulCheckAt ?? 'not yet confirmed'}. `
    + (activityCheckedAt ? `Activity last inspected: ${activityCheckedAt}. ` : '')
    + (clockSkew ? 'Source and browser clocks differ; freshness uses received heartbeats. ' : '')
    + 'Connection status does not indicate an agent is running.'
  return { state, label, detail, tone, isLive: state === 'live', eventAgeMs, sourceAgeMs,
    lastSuccessfulCheckAt: successfulCheckAt, clockSkew, staleAfterMs: threshold, tooltip,
    sync: presentSync(sync, syncReceivedAt, now) }
}
