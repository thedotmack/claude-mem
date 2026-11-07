/** Public, credential-free sync evidence. Transport liveness is not replica freshness. */
export interface SyncDownloadStatus {
  started: boolean;
  inFlight: boolean;
  suspended: boolean;
  authPaused: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
  epoch: string | null;
  cursor: string;
  mode: 'polling' | 'realtime';
  realtimeAvailable: boolean | null;
  socketLive: boolean;
  caughtUp: boolean;
}

export interface ViewerSyncStatus {
  configured: boolean;
  state: 'unconfigured' | 'unknown' | 'current' | 'catching-up' | 'paused' | 'offline' | 'partial' | 'stale';
  mode: 'polling' | 'realtime' | 'disabled';
  checkedAt: number | null;
  observedAt: number;
  message: string;
  upload: { pending: number; lastSuccessAt: number | null; error: string | null };
  download: SyncDownloadStatus | null;
  projection: { epoch: string | null; headSeq: string | null; projectedSeq: string | null; remaining: string | null };
  completeness: { pushQuarantine: number; pullQuarantine: number; excludedNative: number | null; scope: 'eligible' | 'local-history-excluded' | 'unknown' };
}

export interface SyncUploadEvidence {
  configured: boolean;
  pending: Record<string, number>;
  lastFlushAt: number | null;
  lastError: string | null;
  authError: unknown | null;
  quarantine: { count: number };
  pullQuarantine: { count: number };
  queue?: { blockedMutation: { pendingPrerequisites: number } | null };
  hub: { checkedAt: number | null; reachable: boolean | null; epoch: string | null; headSeq: string | null; projectedSeq: string | null };
}

const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const lag = (head: string | null, cursor: string | null): string | null => decimal(head) && decimal(cursor) && BigInt(head) >= BigInt(cursor)
  ? (BigInt(head) - BigInt(cursor)).toString() : null;

/** Pure composition: never probes, schedules, repairs or writes sync state. */
export function composeViewerSyncStatus(upload: SyncUploadEvidence | null, download: SyncDownloadStatus | null, excludedNative: number | null, now = Date.now()): ViewerSyncStatus {
  const hub = upload?.hub;
  const pending = Object.values(upload?.pending ?? {}).reduce((sum, value) => sum + (Number.isSafeInteger(value) && value > 0 ? value : 0), 0);
  const remaining = hub?.reachable === true && hub.epoch !== null && hub.epoch === download?.epoch ? lag(hub.headSeq, download.cursor) : null;
  const projected = hub?.reachable === true ? lag(hub.headSeq, hub.projectedSeq) : null;
  const value: ViewerSyncStatus = {
    configured: upload?.configured === true,
    state: 'unconfigured', mode: upload?.configured ? download?.mode ?? 'polling' : 'disabled', checkedAt: hub?.checkedAt ?? null, observedAt: now,
    message: 'Cloud sync is not configured.',
    upload: { pending, lastSuccessAt: upload?.lastFlushAt ?? null, error: upload?.lastError ?? null }, download,
    projection: { epoch: hub?.epoch ?? null, headSeq: hub?.headSeq ?? null, projectedSeq: hub?.projectedSeq ?? null, remaining },
    completeness: { pushQuarantine: upload?.quarantine.count ?? 0, pullQuarantine: upload?.pullQuarantine.count ?? 0, excludedNative,
      scope: excludedNative === null ? 'unknown' : excludedNative > 0 ? 'local-history-excluded' : 'eligible' },
  };
  const state = (name: ViewerSyncStatus['state'], message: string) => Object.assign(value, { state: name, message });
  if (!value.configured) return value;
  if (upload?.authError || download?.authPaused) return state('paused', 'Cloud sync is paused after authentication or subscription was refused.');
  if (download?.suspended || (download && !download.started)) return state('paused', 'Incoming cloud updates are paused on this device.');
  if (download?.lastError || upload?.lastError || hub?.reachable === false) return state('offline', 'Cloud sync could not finish its latest request. Saved work remains on this device.');
  if (!download || download.lastSuccessAt === null || hub?.reachable !== true || remaining === null || projected === null) return state('unknown', 'Cloud freshness has not been confirmed.');
  if (hub.checkedAt === null || now < hub.checkedAt || now - hub.checkedAt > 60_000 || now < download.lastSuccessAt) return state('stale', 'The last cloud freshness check is old.');
  if (upload?.queue?.blockedMutation) return state('catching-up', 'Some updates are waiting for earlier changes to upload.');
  if (pending > 0 || remaining !== '0' || projected !== '0' || download.inFlight || !download.caughtUp) return state('catching-up', 'Cloud updates are being synchronized.');
  if (value.completeness.pushQuarantine || value.completeness.pullQuarantine) return state('partial', 'Some records need attention before this device is fully synchronized.');
  if (excludedNative === null) return state('unknown', 'Recent updates are current; historical synchronization scope is not yet known.');
  if (excludedNative > 0) return state('partial', 'Recent updates are current. Older local history is outside the selected sync scope.');
  return state('current', 'Shared records are current with the last confirmed cloud check.');
}
