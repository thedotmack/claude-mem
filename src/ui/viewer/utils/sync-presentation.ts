/**
 * Credential-free subset of src/shared/viewer-sync-status.ts used by both browser bundles. It imports nothing:
 * My Work's tests compile it under nodenext resolution, and the viewer under bundler resolution.
 */
export interface SyncStatusForDisplay {
  configured: boolean;
  state: 'unconfigured' | 'unknown' | 'current' | 'catching-up' | 'paused' | 'offline' | 'partial' | 'stale';
  mode: 'polling' | 'realtime' | 'disabled';
  checkedAt: number | null;
  observedAt: number;
  message: string;
  download: { lastSuccessAt: number | null } | null;
  /** Records on this device still waiting to upload: the worker's status carries it (src/shared/viewer-sync-status.ts); a status built elsewhere may leave it out. */
  upload?: { pending: number } | null;
  projection: { remaining: string | null };
  completeness: { pushQuarantine: number; pullQuarantine: number; excludedNative: number | null; scope: 'eligible' | 'local-history-excluded' | 'unknown' };
}

export interface SyncPresentation {
  state: SyncStatusForDisplay['state'];
  label: string;
  detail: string;
  /**
   * The sentences `detail` is made of, so a screen can say each one in the reader's
   * language: the state sentence (the worker's own, or one of SYNC_VIEWER_SENTENCES),
   * the delivery mode, and the changes still to sync. presentSync always sets it;
   * it is optional only for presentations built elsewhere (My Work's tests).
   */
  detailParts?: SyncDetailParts;
  tone: 'neutral' | 'positive' | 'warning';
  isCurrent: boolean;
  /**
   * How many records on this device are waiting to upload, as the worker counted them; null when it did not say (sync
   * off, or an older worker). My Work's Machine and sync shows it.
   */
  pendingUpload?: number | null;
}

export type SyncDeliveryMode = Exclude<SyncStatusForDisplay['mode'], 'disabled'>;
type SyncDetailParts = { sentence: string; mode: SyncDeliveryMode | null; remaining: string | null };

/** The sentence after the state sentence that says how updates arrive. */
export const SYNC_MODE_SENTENCES: Record<SyncDeliveryMode, string> = {
  realtime: 'Mode: realtime with HTTP recovery.',
  polling: 'Mode: HTTP polling.',
};

/** The last sentence while sync catches up: how many changes are still to come ({count} is the worker's decimal string). */
export const SYNC_REMAINING_SENTENCE = 'Changes remaining: {count}.';

/** The state sentences this file writes itself (the worker writes the others, src/shared/viewer-sync-status.ts). */
export const SYNC_VIEWER_SENTENCES = {
  notReported: 'This worker has not reported synchronization freshness.',
  stale: 'The last confirmed cloud check is old; the live connection does not prove the replica is current.',
  unconfirmed: 'Cloud freshness has not been confirmed.',
} as const;

/** The short label for each sync state (the classic viewer's header and My Work's Machine and sync page word it by t()). */
export const SYNC_STATE_LABELS: Record<SyncStatusForDisplay['state'], string> = {
  unconfigured: 'Cloud sync off', unknown: 'Cloud freshness unknown', current: 'Cloud data current',
  'catching-up': 'Cloud catching up', paused: 'Cloud sync paused', offline: 'Cloud sync unavailable',
  partial: 'Cloud sync incomplete', stale: 'Cloud freshness stale',
};
/** The label for a partial sync whose only gap is local history left out of the chosen scope. */
export const SYNC_LIMITED_SCOPE_LABEL = 'Limited sync scope';

/** The detail's sentences joined, each said by `t`: the state sentence, the delivery mode, the changes still to sync. */
function joinSyncDetail(parts: SyncDetailParts, t: (english: string) => string): string {
  const remaining = parts.remaining;
  return [
    t(parts.sentence),
    parts.mode ? t(SYNC_MODE_SENTENCES[parts.mode]) : '',
    remaining !== null ? t(SYNC_REMAINING_SENTENCE).replace(/\{count\}/g, () => remaining) : '',
  ].filter(Boolean).join(' ');
}

/**
 * The sync state's full words in the reader's language (`t`): the one rule for them, which the classic viewer's
 * header and My Work's Machine and sync page both take, as presentSync takes it for the English `detail`. A presentation
 * built without its parts (detailParts) keeps its English detail as it is.
 */
export function syncDetailWords(sync: Pick<SyncPresentation, 'detail' | 'detailParts'>, t: (english: string) => string): string {
  return sync.detailParts ? joinSyncDetail(sync.detailParts, t) : sync.detail;
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
  if (!status) {
    const sentence = SYNC_VIEWER_SENTENCES.notReported;
    return { state: 'unknown', label: SYNC_STATE_LABELS.unknown, detail: sentence, detailParts: { sentence, mode: null, remaining: null }, tone: 'neutral', isCurrent: false };
  }
  if (!status.configured) {
    return { state: 'unconfigured', label: SYNC_STATE_LABELS.unconfigured, detail: status.message,
      detailParts: { sentence: status.message, mode: null, remaining: null }, tone: 'neutral', isCurrent: false, pendingUpload: null };
  }
  const pending = status.upload?.pending;
  const pendingUpload = typeof pending === 'number' && Number.isSafeInteger(pending) && pending >= 0 ? pending : null;
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
  const limitedHistory = state === 'partial' && status.completeness.scope === 'local-history-excluded'
    && status.completeness.pushQuarantine === 0 && status.completeness.pullQuarantine === 0;
  const sentence = state !== status.state
    ? state === 'stale' ? SYNC_VIEWER_SENTENCES.stale : SYNC_VIEWER_SENTENCES.unconfirmed
    : status.message;
  const mode = status.mode === 'disabled' ? null : status.mode;
  const remaining = state === 'catching-up' ? status.projection.remaining : null;
  const detailParts = { sentence, mode, remaining };
  const detail = joinSyncDetail(detailParts, (english) => english);
  return { state, label: limitedHistory ? SYNC_LIMITED_SCOPE_LABEL : SYNC_STATE_LABELS[state], detail, detailParts,
    tone: state === 'current' ? 'positive' : limitedHistory || state === 'unknown' ? 'neutral' : 'warning', isCurrent: state === 'current', pendingUpload };
}
