// Typed copy of claude-mem v15.0.1 plugin/ui/work-view/live-status.js (getConnectionStatus).
// Connection freshness is measured on the browser's monotonic clock. Server
// wall time is displayed as evidence, never used as an agent-presence signal.
export const LOCAL_FEED_STALE_AFTER_MS = 35_000 // Two 15-second heartbeats + margin.

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
}: ConnectionStatusInput): ConnectionStatus {
  const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : LOCAL_FEED_STALE_AFTER_MS
  const eventAgeMs = age(now, lastEventAt)
  const sourceAgeMs = age(now, lastSuccessfulCheckReceivedAt)
  const successfulCheckAt = checkTime(lastSuccessfulCheckAt)
  const clockSkew = successfulCheckAt !== null && wallNow !== null && Number.isFinite(wallNow) && sourceAgeMs !== null
    && Math.abs(wallNow - Date.parse(successfulCheckAt) - sourceAgeMs) > 60_000
  let state: ConnectionState = 'connecting'
  let label = 'Connecting to local feed'
  let detail = 'Waiting for updates from this computer.'
  let tone: ConnectionTone = 'neutral'

  if (!transportConnected) {
    if (reconnecting && eventAgeMs !== null && eventAgeMs > threshold) {
      state = 'stale'; label = 'Local feed stale'; tone = 'warning'
      detail = 'Reconnecting to this computer. No fresh update has arrived; showing the last received work.'
    } else if (reconnecting) {
      state = 'reconnecting'; label = 'Reconnecting to local feed'; tone = 'warning'
      detail = 'Connection interrupted. Showing the last received work while the local feed reconnects.'
    }
  } else if (eventAgeMs === null || eventAgeMs > threshold) {
    if (lastEventAt !== null) {
      state = 'stale'; label = 'Local feed stale'; tone = 'warning'
      detail = 'Local updates have stopped arriving. Showing the last received work.'
    }
  } else if (sourceConnected === false) {
    state = 'unavailable'; label = 'Local source unavailable'; tone = 'warning'
    detail = 'Connected, but saved work cannot be read right now. Showing the last received work.'
  } else if (sourceConnected === true && successfulCheckAt !== null && sourceAgeMs !== null) {
    if (sourceAgeMs > threshold) {
      state = 'stale'; label = 'Local feed stale'; tone = 'warning'
      detail = 'Connected, but the saved work has not been refreshed. Showing the last received work.'
    } else {
      state = 'live'; label = 'Live updates'; tone = 'positive'
      detail = 'Updates are arriving from this computer. Each card shows when its work was last updated.'
    }
  }

  const tooltip = `Last successful local check: ${successfulCheckAt ?? 'not yet confirmed'}. `
    + (clockSkew ? 'Source and browser clocks differ; freshness uses received heartbeats. ' : '')
    + 'Connection status does not indicate an agent is running.'
  return { state, label, detail, tone, isLive: state === 'live', eventAgeMs, sourceAgeMs,
    lastSuccessfulCheckAt: successfulCheckAt, clockSkew, staleAfterMs: threshold, tooltip }
}
