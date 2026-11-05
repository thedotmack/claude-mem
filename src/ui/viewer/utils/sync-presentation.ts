/** Credential-free subset of src/shared/viewer-sync-status.ts used by both browser bundles. */
export interface SyncStatusForDisplay {
  configured: boolean;
  state: 'unconfigured' | 'unknown' | 'current' | 'catching-up' | 'paused' | 'offline' | 'partial' | 'stale';
  mode: 'polling' | 'realtime' | 'disabled';
  checkedAt: number | null;
  observedAt: number;
  message: string;
  download: { lastSuccessAt: number | null } | null;
  projection: { remaining: string | null };
  completeness: { pushQuarantine: number; pullQuarantine: number; excludedNative: number | null; scope: 'eligible' | 'local-history-excluded' | 'unknown' };
}

export interface SyncPresentation {
  state: SyncStatusForDisplay['state'];
  label: string;
  detail: string;
  tone: 'neutral' | 'positive' | 'warning';
  isCurrent: boolean;
}

export const SYNC_EVIDENCE_STALE_MS = 60_000;

export function isSyncStatus(value: unknown): value is SyncStatusForDisplay {
  const status = value as SyncStatusForDisplay | null;
  return !!status && typeof status.configured === 'boolean'
    && ['unconfigured', 'unknown', 'current', 'catching-up', 'paused', 'offline', 'partial', 'stale'].includes(status.state)
    && ['polling', 'realtime', 'disabled'].includes(status.mode)
    && Number.isFinite(status.observedAt) && typeof status.message === 'string'
    && (status.checkedAt === null || Number.isFinite(status.checkedAt))
    && !!status.projection && (status.projection.remaining === null || /^(0|[1-9]\d*)$/.test(status.projection.remaining))
    && !!status.completeness && Number.isSafeInteger(status.completeness.pushQuarantine) && status.completeness.pushQuarantine >= 0
    && Number.isSafeInteger(status.completeness.pullQuarantine) && status.completeness.pullQuarantine >= 0
    && ['eligible', 'local-history-excluded', 'unknown'].includes(status.completeness.scope)
    && (status.download === null || (typeof status.download === 'object'
      && (status.download.lastSuccessAt === null || Number.isFinite(status.download.lastSuccessAt))));
}

/** Age uses server-relative evidence at receipt plus a browser monotonic clock, never browser wall time. */
export function presentSync(status: SyncStatusForDisplay | null, receivedAt: number | null, now: number): SyncPresentation {
  if (!status) return { state: 'unknown', label: 'Cloud freshness unknown', detail: 'This worker has not reported synchronization freshness.', tone: 'neutral', isCurrent: false };
  if (!status.configured) return { state: 'unconfigured', label: 'Cloud sync off', detail: status.message, tone: 'neutral', isCurrent: false };
  const checked = status.checkedAt;
  const pulled = status.download?.lastSuccessAt ?? null;
  // A fresh authoritative head equal to the applied cursor proves quiet data is current;
  // the previous HTTP pull may be old when realtime is connected and no writes arrived.
  const at = checked === null || pulled === null || pulled > status.observedAt ? null : checked;
  const ageAtReceipt = at === null ? null : status.observedAt - at;
  const elapsed = receivedAt === null ? null : now - receivedAt;
  let state = status.state;
  if (['current', 'partial', 'catching-up'].includes(state)) {
    if (ageAtReceipt === null || elapsed === null || ageAtReceipt < 0 || elapsed < 0 || !Number.isFinite(ageAtReceipt + elapsed)) state = 'unknown';
    else if (ageAtReceipt + elapsed > SYNC_EVIDENCE_STALE_MS) state = 'stale';
  }
  const labels: Record<SyncStatusForDisplay['state'], string> = {
    unconfigured: 'Cloud sync off', unknown: 'Cloud freshness unknown', current: 'Cloud data current',
    'catching-up': 'Cloud catching up', paused: 'Cloud sync paused', offline: 'Cloud sync unavailable',
    partial: 'Cloud sync incomplete', stale: 'Cloud freshness stale',
  };
  const limitedHistory = state === 'partial' && status.completeness.scope === 'local-history-excluded'
    && status.completeness.pushQuarantine === 0 && status.completeness.pullQuarantine === 0;
  let detail = state !== status.state
    ? state === 'stale' ? 'The last confirmed cloud check is old; the live connection does not prove the replica is current.' : 'Cloud freshness has not been confirmed.'
    : status.message;
  detail += status.mode === 'realtime' ? ' Mode: realtime with HTTP recovery.' : status.mode === 'polling' ? ' Mode: HTTP polling.' : '';
  if (state === 'catching-up' && status.projection.remaining !== null) detail += ` Changes remaining: ${status.projection.remaining}.`;
  return { state, label: limitedHistory ? 'Limited sync scope' : labels[state], detail,
    tone: state === 'current' ? 'positive' : limitedHistory || state === 'unknown' ? 'neutral' : 'warning', isCurrent: state === 'current' };
}
