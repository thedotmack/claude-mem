// ============================================================
// Observation image refs for My Work (pure; no React).
// Copied from thedotmack/claude-mem-pro PR #265 at 3dd60b18,
// src/components/timeline-viewer/media.ts. Changes from that copy:
//   - URLs point at this worker's media routes (/api/media/*,
//     MediaRoutes.ts), not Pro's /api/observation-media/*. On work.cmem.ai
//     the viewer-host gate forwards the same paths to the hosted worker.
//   - The manifest normalizers (normMedia, normFeedMedia) are gone: the
//     worker validates `cmem_media_v1` before the Work Viewer wire carries it
//     (agent-view.mjs, observationMediaFromMetadata), so the browser only
//     ever receives refs.
//   - VMedia/VMediaRef are the wire types, so the two cannot drift.
//   - provenanceDetails reads the worker's `encoderVersion` field.
//   - "pending" copy says processing, not uploading: locally an image is
//     pending while it converts or while a second device downloads it.
//   - Words take the reader's translator (`t`, English by default), so the
//     strip and the gallery speak the page's language (plan rule 4), and the
//     inspection reads as people say it: "not read by the agent".
// Builds the ONLY URLs the browser uses (same-origin, never a storage URL,
// object key or locator), maps route answers to display states, and holds
// the gallery's keyboard rules. Tested by tests/ui/my-work/observation-media.test.ts.
// ============================================================
import type { WorkViewMediaManifest, WorkViewMediaRef } from '../../live/work-view-api-types.ts'
import { interpolate } from '../../../../i18n/locale.ts'

/** The page's translator. Each word table below calls it on its own literal words, so the catalog test sees them. */
export type Translate = (text: string) => string
const english: Translate = (text) => text

export type VMediaRef = WorkViewMediaRef;

/**
 * The validated `cmem_media_v1` manifest as the Work Viewer wire carries it —
 * attachment ids, request labels, inspection and the overflow flag — and
 * ABSENT for image-free rows.
 */
export type VMedia = WorkViewMediaManifest;

/** Thumbnails rendered in the selected-observation strip; the rest are "+N". Reason: the contract's images per event. */
export const THUMBNAIL_LIMIT = 4;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertAttachmentId(id: string): string {
  if (!UUID_V4.test(id)) throw new Error('invalid attachment id');
  return id;
}

/**
 * Ids per status call. Reason: the worker's GET /api/media/status refuses more
 * (MEDIA_STATUS_MAX_IDS = media-contract.ts MEDIA_LIMITS.maxObservationRefs,
 * restated because My Work cannot import that file; tests/ui/my-work/observation-media.test.ts pins them equal).
 */
export const MEDIA_STATUS_MAX_IDS = 32;

/** Batch readiness (≤ 32 ids): `{attachments:[{id,state}]}`. */
export function mediaStatusUrl(ids: string[]): string {
  if (ids.length === 0 || ids.length > MEDIA_STATUS_MAX_IDS) throw new Error('1..32 ids');
  return `/api/media/status?ids=${ids.map(assertAttachmentId).join(',')}`;
}

/** Same-origin viewer variant bytes (private, no-store; loopback/own-page checked by the worker). */
export function mediaViewerUrl(id: string): string {
  return `/api/media/${assertAttachmentId(id)}/viewer`;
}

/** The ≤ 256 KiB derivative, used for thumbnails so a strip stays light. */
export function mediaThumbnailUrl(id: string): string {
  return `/api/media/${assertAttachmentId(id)}/llm`;
}

/** Generic metadata (recipe, encoder, variant sizes; no locator or provenance) for the details panel, never the owner-only details route. */
export function mediaDescriptorUrl(id: string): string {
  return `/api/media/${assertAttachmentId(id)}`;
}

/**
 * Every viewer media request: same-origin only. Locally the worker's guard
 * checks loopback and the page's own origin; on work.cmem.ai the session
 * cookie the browser already holds. No bearer header, never cross-origin.
 */
export const MEDIA_FETCH_INIT: RequestInit = Object.freeze({ credentials: 'same-origin', cache: 'no-store' }) as RequestInit;

export type ServerMediaState = 'ready' | 'pending' | 'deleted' | 'rejected';

/** Display states. Inspection is separate (a ready image can be uninspected). */
export type MediaDisplayState =
  | 'checking'     // status not answered yet
  | 'pending'      // not uploaded yet (or in flight)
  | 'ready'        // uploaded; bytes loadable
  | 'deleted'      // the owner or a deletion removed it
  | 'rejected'     // the upload was refused for good (format, size, dimensions, checksum)
  | 'failed'       // the image bytes failed to load or verify
  | 'unavailable'; // readiness could not be resolved (route error / lapsed access)

export function parseStatusResponse(body: unknown, requested: string[]): Map<string, ServerMediaState> {
  const states = new Map<string, ServerMediaState>();
  const list = (body as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(list)) return states;
  const wanted = new Set(requested);
  for (const entry of list) {
    const id = (entry as { id?: unknown })?.id;
    const state = (entry as { state?: unknown })?.state;
    if (typeof id === 'string' && wanted.has(id) && (state === 'ready' || state === 'pending' || state === 'deleted' || state === 'rejected')) {
      states.set(id, state);
    }
  }
  return states;
}

export function displayState(
  serverState: ServerMediaState | undefined,
  statusFailed: boolean,
  imageFailed: boolean,
): MediaDisplayState {
  if (statusFailed) return 'unavailable';
  if (serverState === undefined) return 'checking';
  if (serverState === 'ready' && imageFailed) return 'failed';
  return serverState;
}

/**
 * Each display state's word, in the reader's language: the one table the strip, the viewer's first line and its
 * technical details take a state's word from. A ready image is "Saved", the word the legend and the viewer lead with
 * (c-obs-media M: "Saved. The agent has not read this image.").
 */
export const STATE_WORDS: Record<MediaDisplayState, (t: Translate) => string> = {
  checking: (t) => t('Checking…'),
  pending: (t) => t('Processing…'),
  ready: (t) => t('Saved'),
  deleted: (t) => t('Deleted'),
  rejected: (t) => t('Rejected'),
  failed: (t) => t('Could not load'),
  unavailable: (t) => t('Unavailable'),
};

/** The English words of each display state, from STATE_WORDS. */
export const STATE_COPY = Object.fromEntries(
  (Object.keys(STATE_WORDS) as MediaDisplayState[]).map((state) => [state, STATE_WORDS[state](english)]),
) as Record<MediaDisplayState, string>;

/**
 * Whether the agent has read an image, in plain words (c-obs-media: "Not inspected by the model" read as a developer's
 * fact). `short`: inside a sentence, as a thumbnail's name ends. `lead`: the sentence the image viewer opens with, after
 * the image's state word (`{state}`, from STATE_WORDS).
 */
const INSPECTION_WORDS: Record<VMediaRef['inspection'], { short: (t: Translate) => string; lead: (t: Translate) => string }> = {
  inspected: { short: (t) => t('read by the agent'), lead: (t) => t('{state}. The agent has read this image.') },
  uninspected: { short: (t) => t('not read by the agent'), lead: (t) => t('{state}. The agent has not read this image.') },
};

export function inspectionCopy(inspection: VMediaRef['inspection'], t: Translate = english): string {
  return INSPECTION_WORDS[inspection].short(t);
}

/**
 * The image viewer's first line (c-obs-media M): the image's state in its own word, then whether the agent has read it
 * ("Saved. The agent has not read this image."; "Deleted. …"; "Could not load. …"), so an image that is not saved never
 * leads with "Saved.". A state word's own trailing "…" ("Processing…") gives way to the sentence's full stop.
 */
export function inspectionLead(state: MediaDisplayState, inspection: VMediaRef['inspection'], t: Translate = english): string {
  return interpolate(INSPECTION_WORDS[inspection].lead(t), { state: STATE_WORDS[state](t).replace(/…$/u, '') });
}

export function altText(ref: VMediaRef, index: number, total: number, title: string, t: Translate = english): string {
  const values = { current: index + 1, total, label: ref.label, title };
  if (total > 1) {
    return interpolate(ref.inspection === 'uninspected'
      ? t('Screenshot {current} of {total} ({label}) attached to: {title} (not read by the agent)')
      : t('Screenshot {current} of {total} ({label}) attached to: {title}'), values);
  }
  return interpolate(ref.inspection === 'uninspected'
    ? t('Screenshot ({label}) attached to: {title} (not read by the agent)')
    : t('Screenshot ({label}) attached to: {title}'), values);
}

export type GalleryAction = { type: 'close' } | { type: 'go'; index: number } | null;

/** Gallery keyboard: Esc closes; arrows wrap; Home/End jump. */
export function galleryKeyAction(key: string, index: number, total: number): GalleryAction {
  if (key === 'Escape') return { type: 'close' };
  if (total <= 0) return null;
  if (key === 'ArrowRight') return { type: 'go', index: (index + 1) % total };
  if (key === 'ArrowLeft') return { type: 'go', index: (index - 1 + total) % total };
  if (key === 'Home') return { type: 'go', index: 0 };
  if (key === 'End') return { type: 'go', index: total - 1 };
  return null;
}

/** Next focus index for Tab / Shift+Tab inside the dialog (focus trap). */
export function trapFocusIndex(current: number, total: number, backwards: boolean): number {
  if (total <= 0) return -1;
  if (current < 0) return backwards ? total - 1 : 0;
  return backwards ? (current - 1 + total) % total : (current + 1) % total;
}

export interface ProvenanceDetails {
  recipe: string;
  encoder: string;
  viewer: { width: number; height: number; byteLength: number } | null;
  llm: { width: number; height: number; byteLength: number } | null;
}

function variantFacts(value: unknown): ProvenanceDetails['viewer'] {
  const variant = value as { width?: unknown; height?: unknown; byteLength?: unknown } | null;
  if (!variant) return null;
  const { width, height, byteLength } = variant;
  if (typeof width !== 'number' || typeof height !== 'number' || typeof byteLength !== 'number') return null;
  return { width, height, byteLength };
}

/**
 * The descriptor fields the details panel shows: recipe, encoder and variant
 * dimensions/sizes. Hashes and anything else in the response are dropped.
 */
export function provenanceDetails(descriptor: unknown): ProvenanceDetails | null {
  const fields = descriptor as { recipe?: unknown; encoderVersion?: unknown; viewer?: unknown; llm?: unknown } | null;
  if (!fields || typeof fields.recipe !== 'string' || typeof fields.encoderVersion !== 'string') return null;
  return {
    recipe: fields.recipe,
    encoder: fields.encoderVersion,
    viewer: variantFacts(fields.viewer),
    llm: variantFacts(fields.llm),
  };
}

export function formatBytes(byteLength: number): string {
  if (byteLength >= 1024 * 1024) return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`;
  if (byteLength >= 1024) return `${Math.round(byteLength / 1024)} KiB`;
  return `${byteLength} B`;
}
