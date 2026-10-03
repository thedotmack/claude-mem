import type { MediaMetadataResponse, MediaOwnerDetailsResponse, ObservationMediaRef } from '../types';

/** Thumbnails rendered on a card; the rest are counted and reachable in the gallery. */
export const MAX_CARD_THUMBNAILS = 4;
/** Pending/downloading media is re-checked this often, a bounded number of times. */
export const MEDIA_PENDING_POLL_MS = 4000;
export const MEDIA_PENDING_MAX_POLLS = 30;

export const mediaMetadataUrl = (id: string) => `/api/media/${encodeURIComponent(id)}`;
export const mediaVariantUrl = (id: string, variant: 'viewer' | 'llm') => `/api/media/${encodeURIComponent(id)}/${variant}`;
export const mediaOwnerDetailsUrl = (id: string) => `/api/media/${encodeURIComponent(id)}/details`;

/** What the viewer shows for one attachment. Readiness always comes from /api/media/:id. */
export type MediaDisplayState =
  | { kind: 'loading' }
  | { kind: 'ready'; metadata: MediaMetadataResponse }
  /** Still converting locally (or the route reported not-ready). `stalled`: polling gave up; offer Retry. */
  | { kind: 'pending'; stalled?: boolean }
  /** Second-device replica whose bytes are being fetched: never shown as a failure. */
  | { kind: 'downloading'; stalled?: boolean }
  /** The image itself could not meet the v1 bounds or format. */
  | { kind: 'rejected'; code: string }
  /** Conversion or storage failed for a reason other than the image. */
  | { kind: 'failed'; code: string }
  /** Deleted or never stored on this device. */
  | { kind: 'unavailable' }
  /** The read itself failed (network, storage outage, refused); retryable. */
  | { kind: 'error'; code: string };

const REJECTION_CODES = new Set([
  'unsupported_format', 'mime_mismatch', 'invalid_image', 'animated_image', 'pixel_limit',
  'dimension_limit', 'source_too_large', 'canonical_too_large', 'derivative_too_large', 'unsupported_source',
]);

const SAFE_CODE = /^[a-z_]{1,40}$/;
const safeCode = (value: unknown, fallback: string) => typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;

/** Map one /api/media/:id response (status + parsed JSON body) to a display state. */
export function mediaDisplayStateFrom(status: number, body: unknown): MediaDisplayState {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (status === 200) {
    switch (record.state) {
      case 'ready': return { kind: 'ready', metadata: body as MediaMetadataResponse };
      case 'converting': return { kind: 'pending' };
      case 'unresolved_replica': return { kind: 'downloading' };
      case 'failed': {
        const code = safeCode(record.failureCode, 'storage_unavailable');
        return REJECTION_CODES.has(code) ? { kind: 'rejected', code } : { kind: 'failed', code };
      }
      default: return { kind: 'unavailable' };
    }
  }
  if (status === 404) return { kind: 'unavailable' };
  if (status === 409) return { kind: 'pending' };
  return { kind: 'error', code: safeCode(record.code, status === 0 ? 'network_error' : 'storage_unavailable') };
}

export const shouldPollMediaState = (state: MediaDisplayState) => state.kind === 'pending' || state.kind === 'downloading';

/** Read errors and pending states whose bounded polling ended can be retried by hand. */
export const canRetryMediaState = (state: MediaDisplayState) =>
  state.kind === 'error' || ((state.kind === 'pending' || state.kind === 'downloading') && state.stalled === true);

/** Human status for a non-ready tile; ready tiles render the image instead. */
export function mediaStatusText(state: MediaDisplayState): string {
  switch (state.kind) {
    case 'loading': return 'Loading…';
    case 'ready': return 'Ready';
    case 'pending': return state.stalled ? 'Still processing' : 'Processing…';
    case 'downloading': return state.stalled ? 'Still downloading' : 'Downloading…';
    case 'rejected': return `Rejected (${state.code})`;
    case 'failed': return `Failed (${state.code})`;
    case 'unavailable': return 'Image removed';
    case 'error': return 'Couldn’t load';
  }
}

/** Alt text comes from the bounded request label, never filenames or captions. */
export function mediaAltText(ref: ObservationMediaRef, index: number, count: number, observationId: number): string {
  return `Image ${ref.label} (${index + 1} of ${count}) attached to observation #${observationId}`;
}

export const inspectionText = (ref: ObservationMediaRef) =>
  ref.inspection === 'inspected' ? 'Inspected by the observer' : 'Not inspected (stored only)';

export function sourceAvailabilityText(details: MediaOwnerDetailsResponse): string {
  if (details.platform === null) return 'Synced from another device; converted copy retained';
  switch (details.sourceAvailability) {
    case 'file_present': return 'Source file still on disk; converted copy retained';
    case 'file_missing': return 'Source file no longer available; converted copy retained';
    default: return 'Converted copy retained; original not stored';
  }
}

export function formatMediaBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export type GalleryKeyAction = { type: 'close' } | { type: 'show'; index: number } | null;

/**
 * Lightbox keyboard behaviour: Escape closes; arrows, Home and End move
 * between images without wrapping. Unhandled keys return null.
 */
export function galleryKeyAction(key: string, index: number, count: number): GalleryKeyAction {
  switch (key) {
    case 'Escape': return { type: 'close' };
    case 'ArrowRight': return index < count - 1 ? { type: 'show', index: index + 1 } : null;
    case 'ArrowLeft': return index > 0 ? { type: 'show', index: index - 1 } : null;
    case 'Home': return index !== 0 && count > 0 ? { type: 'show', index: 0 } : null;
    case 'End': return index !== count - 1 && count > 0 ? { type: 'show', index: count - 1 } : null;
    default: return null;
  }
}

/** The next element for a Tab press inside the dialog, wrapping at either end. */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}
