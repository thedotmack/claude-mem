// ============================================================
// My Work — observation images.
// Copied from thedotmack/claude-mem-pro PR #265 at 3dd60b18,
// src/components/timeline-viewer/ObsMedia.tsx. Changes from that copy:
//   - The default MediaSource is this worker's (worker-media-source.ts), not
//     Pro's cloud routes. Sample mode provides a fixture source instead.
//   - Class names use the `obs-media-` prefix; the styles live in index.css
//     and read My Work's own theme variables.
//   - The gallery portals into the request drawer when opened from it (the
//     drawer is a Radix modal that owns focus and outside clicks), else into
//     document.body.
//   - A request card shows a preview of a request's images, so the badge
//     takes the request's `count` and the strip takes `total` and `onMore`
//     ("+N" opens the drawer that holds every image).
//   - "pending" copy says processing, not uploading.
//   - The open image is tracked by id, so a live update that shrinks the
//     list closes the gallery instead of crashing it; thumbnail and full-image
//     load failures are kept apart, and a failed image offers "Try again".
//   MediaCountBadge  — image count on a rail card (no network).
//   ObsMediaStrip    — selected-observation face: bounded thumbnail strip
//                      (THUMBNAIL_LIMIT, then "+N"), per-image state and
//                      inspection, opens the gallery.
//   MediaGallery     — modal lightbox: Esc closes, ←/→ (wrapping), Home/End,
//                      focus moves in on open, is trapped while open and is
//                      restored to the opening thumbnail on close; alt text
//                      and provenance details (recipe, encoder, sizes).
// Every request is same-origin and session-authenticated through the media
// routes (owner-checked server-side). The browser never sees a storage URL,
// object key, bucket name, provenance locator or credential.
// Image-free observations render nothing here.
// ============================================================
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Image as ImageIcon, X } from 'lucide-react';

import { workerMediaSource } from './worker-media-source';
import { setTimeoutThenWaitUntilCloudPageVisible } from '@/live/served-from';
import {
  altText,
  displayState,
  formatBytes,
  galleryKeyAction,
  inspectionCopy,
  provenanceDetails,
  STATE_COPY,
  THUMBNAIL_LIMIT,
  trapFocusIndex,
  type MediaDisplayState,
  type ProvenanceDetails,
  type ServerMediaState,
  type VMedia,
  type VMediaRef,
} from './media';

/** Where media answers come from. Production: the worker's media routes. */
export interface MediaSource {
  /** Throws when readiness cannot be resolved. */
  status(ids: string[]): Promise<Map<string, ServerMediaState>>;
  /** Small variant for thumbnails (the ≤ 256 KiB LLM derivative). */
  thumbnailUrl(id: string): string;
  /** Full viewer variant for the gallery. */
  imageUrl(id: string): string;
  descriptor(id: string): Promise<unknown>;
}

export const MediaSourceContext = createContext<MediaSource>(workerMediaSource);

/**
 * Readiness is rechecked this often while an image is pending or the status
 * route failed, up to STATUS_RECHECK_LIMIT times (5 minutes), then the last
 * state stays on screen until the card is opened again.
 * Reason (from PR #265): an upload to Pro holds a 120 s write lease, so 5
 * minutes covers one full lease and a retry, which is what a hosted replica
 * waits on; a local conversion is bounded far lower (5 s timeout,
 * media-contract.ts). The limit stops a card left open from polling forever.
 */
const STATUS_RECHECK_MS = 15_000;
const STATUS_RECHECK_LIMIT = 20;

export interface MediaStatusResult {
  map: Map<string, ServerMediaState>;
  failed: boolean;
}

/**
 * Resolve readiness now and keep rechecking while it can still change: an image
 * is pending, or the status route failed and may recover. Returns the stop
 * function. `schedule` is the timer, so the sequence is testable without one.
 * By default a hidden cloud tab waits until it is shown again, so it does not
 * keep the cloud viewer's machine awake.
 */
export function watchMediaStatus(
  ids: string[],
  status: MediaSource['status'],
  onResult: (result: MediaStatusResult) => void,
  schedule: (recheck: () => void, ms: number) => () => void = setTimeoutThenWaitUntilCloudPageVisible,
): () => void {
  let stopped = false;
  let cancelRecheck: (() => void) | undefined;
  let rechecks = 0;
  const recheckLater = () => {
    if (rechecks >= STATUS_RECHECK_LIMIT) return;
    rechecks += 1;
    cancelRecheck = schedule(() => void check(), STATUS_RECHECK_MS);
  };
  const check = async () => {
    try {
      const map = await status(ids);
      if (stopped) return;
      onResult({ map, failed: false });
      if (ids.some((id) => map.get(id) === 'pending')) recheckLater();
    } catch {
      if (stopped) return;
      onResult({ map: new Map(), failed: true });
      recheckLater();
    }
  };
  void check();
  return () => {
    stopped = true;
    cancelRecheck?.();
  };
}

/** `count`: the request's distinct images when `media` is only its card preview. */
export function MediaCountBadge({ media, count }: { media?: VMedia; count?: number }) {
  const total = count ?? media?.attachments.length ?? 0;
  if (!media || total === 0) return null;
  const label = `${total} image${total === 1 ? '' : 's'}${media.overflow ? ' (more on the source event)' : ''}`;
  return (
    <span className="obs-media-count" role="img" aria-label={label} title={label}>
      <ImageIcon size={11} strokeWidth={2} aria-hidden />
      {total}
      {media.overflow ? '+' : ''}
    </span>
  );
}

/** Readiness for one observation's refs, rechecked while any is pending. */
function useMediaStates(refs: VMediaRef[]) {
  const source = useContext(MediaSourceContext);
  const key = refs.map((ref) => ref.id).join(',');
  const [states, setStates] = useState<{ key: string; map: Map<string, ServerMediaState>; failed: boolean }>({
    key: '', map: new Map(), failed: false,
  });

  useEffect(() => {
    if (!key) return;
    return watchMediaStatus(
      key.split(','),
      (ids) => source.status(ids),
      (result) => setStates({ key, ...result }),
    );
  }, [key, source]);

  return states.key === key ? states : { key, map: new Map<string, ServerMediaState>(), failed: false };
}

const NO_REFS: VMediaRef[] = [];

/**
 * `total` and `onMore`: on a request card `media` holds only the first
 * THUMBNAIL_LIMIT refs, so the strip counts `total` and its "+N" calls
 * `onMore` (the drawer, which lists every image) instead of opening the gallery.
 */
export function ObsMediaStrip({ media, title, total, onMore }: { media?: VMedia; title: string; total?: number; onMore?: () => void }) {
  const source = useContext(MediaSourceContext);
  const refs = media?.attachments ?? NO_REFS;
  const statuses = useMediaStates(refs);
  // Load failures per variant: a broken thumbnail must not hide a readable full image (and the reverse).
  const [brokenThumbnails, setBrokenThumbnails] = useState<Set<string>>(() => new Set());
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());
  // Bumped by Retry so every <img> remounts and asks the worker again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // The open image is tracked by id, not position: a live update can shrink or reorder `refs` while it is open.
  const [openId, setOpenId] = useState<string | null>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const [portalRoot, setPortalRoot] = useState<Element | null>(null);

  const markThumbnailBroken = useCallback((id: string) => {
    setBrokenThumbnails((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
  }, []);
  const markImageBroken = useCallback((id: string) => {
    setBrokenImages((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
  }, []);
  const retry = useCallback((id: string) => {
    const without = (previous: Set<string>) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    };
    setBrokenThumbnails(without);
    setBrokenImages(without);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const openIndex = openId === null ? -1 : refs.findIndex((ref) => ref.id === openId);
  // The open image left the list (a live update): close the gallery rather than show another image or crash.
  useEffect(() => {
    if (openId !== null && openIndex < 0) setOpenId(null);
  }, [openId, openIndex]);

  if (refs.length === 0) return null;
  const thumbnailStateOf = (ref: VMediaRef): MediaDisplayState =>
    displayState(statuses.map.get(ref.id), statuses.failed, brokenThumbnails.has(ref.id));
  const imageStateOf = (ref: VMediaRef): MediaDisplayState =>
    displayState(statuses.map.get(ref.id), statuses.failed, brokenImages.has(ref.id));
  const visible = refs.slice(0, THUMBNAIL_LIMIT);
  const count = Math.max(total ?? refs.length, refs.length);
  const partial = count > refs.length;
  const hidden = count - visible.length;
  // Counted only when every ref is here: a preview's count would undercount.
  const uninspected = partial ? 0 : refs.filter((ref) => ref.inspection === 'uninspected').length;

  const open = (index: number, trigger: HTMLElement) => {
    lastTrigger.current = trigger;
    // Inside the request drawer the gallery renders in the drawer's content:
    // the drawer is a Radix modal that disables pointer events outside itself
    // and pulls focus back in. Elsewhere it renders at document.body, outside
    // any card that clips.
    setPortalRoot(trigger.closest('[data-slot="sheet-content"]') ?? document.body);
    setOpenId(refs[index].id);
  };
  const close = () => {
    setOpenId(null);
    // Restore focus to whatever opened the gallery.
    window.requestAnimationFrame(() => lastTrigger.current?.focus());
  };

  return (
    <div className="obs-media" aria-label={`${count} attached image${count === 1 ? '' : 's'}`} role="group">
      <div className="obs-media-head">
        <span>
          {count} image{count === 1 ? '' : 's'}
          {media?.overflow ? ' · more on the source event' : ''}
        </span>
        {uninspected > 0 && <span className="obs-media-tag">{uninspected} not inspected</span>}
      </div>
      <div className="obs-media-strip">
        {visible.map((ref, index) => {
          const state = thumbnailStateOf(ref);
          return (
            <button
              key={ref.id}
              type="button"
              className="obs-media-thumb"
              data-state={state}
              onClick={(event) => open(index, event.currentTarget)}
              aria-label={`Open image ${index + 1} of ${count} (${ref.label}): ${STATE_COPY[state]}, ${inspectionCopy(ref.inspection).toLowerCase()}`}
            >
              {state === 'ready' ? (
                <img
                  key={loadAttempt}
                  src={source.thumbnailUrl(ref.id)}
                  alt={altText(ref, index, refs.length, title)}
                  loading="lazy"
                  decoding="async"
                  onError={() => markThumbnailBroken(ref.id)}
                />
              ) : (
                <span className="obs-media-state">{STATE_COPY[state]}</span>
              )}
              {ref.inspection === 'uninspected' && <span className="obs-media-dot" aria-hidden title="Not inspected" />}
            </button>
          );
        })}
        {hidden > 0 && (!partial || onMore) && (
          <button
            type="button"
            className="obs-media-more"
            onClick={(event) => (partial ? onMore?.() : open(THUMBNAIL_LIMIT, event.currentTarget))}
            aria-label={`Show ${hidden} more image${hidden === 1 ? '' : 's'}`}
          >
            +{hidden}
          </button>
        )}
      </div>
      {openIndex >= 0 && portalRoot && createPortal(
        <MediaGallery
          refs={refs}
          index={openIndex}
          title={title}
          stateOf={imageStateOf}
          loadAttempt={loadAttempt}
          onBroken={markImageBroken}
          onRetry={retry}
          onIndex={(index) => setOpenId(refs[index].id)}
          onClose={close}
        />,
        portalRoot,
      )}
    </div>
  );
}

function MediaGallery({
  refs,
  index,
  title,
  stateOf,
  loadAttempt,
  onBroken,
  onRetry,
  onIndex,
  onClose,
}: {
  refs: VMediaRef[];
  index: number;
  title: string;
  stateOf: (ref: VMediaRef) => MediaDisplayState;
  loadAttempt: number;
  onBroken: (id: string) => void;
  /** Clears this image's load failures and asks the worker for its bytes again. */
  onRetry: (id: string) => void;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const source = useContext(MediaSourceContext);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const detailsId = useId();
  const ref = refs[index];
  const state = stateOf(ref);
  const [details, setDetails] = useState<{ id: string; value: ProvenanceDetails | null; failed: boolean } | null>(null);

  // Focus moves into the dialog when it opens.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Provenance for the shown image (ready images only).
  useEffect(() => {
    if (state !== 'ready') return;
    let cancelled = false;
    source.descriptor(ref.id)
      .then((descriptor) => { if (!cancelled) setDetails({ id: ref.id, value: provenanceDetails(descriptor), failed: false }); })
      .catch(() => { if (!cancelled) setDetails({ id: ref.id, value: null, failed: true }); });
    return () => { cancelled = true; };
  }, [ref.id, state, source]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const focusables = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [],
      );
      const next = trapFocusIndex(focusables.indexOf(document.activeElement as HTMLElement), focusables.length, event.shiftKey);
      if (next >= 0) {
        event.preventDefault();
        // Inside the request drawer, the drawer's own focus scope also handles Tab; once the
        // gallery moved focus, letting it run would send focus back into the drawer.
        event.stopPropagation();
        focusables[next].focus();
      }
      return;
    }
    const action = galleryKeyAction(event.key, index, refs.length);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.type === 'close') onClose();
    else onIndex(action.index);
  };

  const shownDetails = details?.id === ref.id ? details : null;
  return (
    <div className="obs-media-gallerybackdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="obs-media-gallery"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={detailsId}
        onKeyDown={onKeyDown}
      >
        <header className="obs-media-galleryhead">
          <h2 id={headingId}>
            Image {index + 1} of {refs.length} · <span>{ref.label}</span>
          </h2>
          <button ref={closeRef} type="button" className="obs-media-galleryclose" onClick={onClose} aria-label="Close image viewer (Escape)">
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="obs-media-galleryframe" data-state={state}>
          {refs.length > 1 && (
            <button type="button" className="obs-media-gallerynav is-prev" onClick={() => onIndex((index - 1 + refs.length) % refs.length)} aria-label="Previous image">
              <ChevronLeft size={18} strokeWidth={2} aria-hidden />
            </button>
          )}
          {state === 'ready' ? (
            <img key={`${ref.id}:${loadAttempt}`} src={source.imageUrl(ref.id)} alt={altText(ref, index, refs.length, title)} onError={() => onBroken(ref.id)} />
          ) : (
            <div className="obs-media-gallerystate">
              <p role="status">{STATE_COPY[state]}{state === 'pending' ? ' — the image is still being converted or downloaded.' : state === 'deleted' ? ' — this image was deleted.' : state === 'rejected' ? ' — the image could not be stored (unsupported, out of bounds, or conversion failed).' : state === 'failed' ? ' — the image could not be loaded or verified.' : state === 'unavailable' ? ' — image status could not be resolved.' : ''}</p>
              {state === 'failed' && (
                <button
                  type="button"
                  className="obs-media-galleryretry"
                  onClick={() => {
                    // This button unmounts once the failure clears; keep focus inside the dialog.
                    closeRef.current?.focus();
                    onRetry(ref.id);
                  }}
                >
                  Try again
                </button>
              )}
            </div>
          )}
          {refs.length > 1 && (
            <button type="button" className="obs-media-gallerynav is-next" onClick={() => onIndex((index + 1) % refs.length)} aria-label="Next image">
              <ChevronRight size={18} strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
        <dl className="obs-media-gallerydetails" id={detailsId}>
          <div><dt>State</dt><dd>{STATE_COPY[state]}</dd></div>
          <div><dt>Inspection</dt><dd>{inspectionCopy(ref.inspection)}</dd></div>
          {shownDetails?.value && (
            <>
              <div><dt>Recipe</dt><dd>{shownDetails.value.recipe}</dd></div>
              <div><dt>Encoder</dt><dd>{shownDetails.value.encoder}</dd></div>
              {shownDetails.value.viewer && (
                <div><dt>Retained</dt><dd>{shownDetails.value.viewer.width}×{shownDetails.value.viewer.height} WebP · {formatBytes(shownDetails.value.viewer.byteLength)}</dd></div>
              )}
              {shownDetails.value.llm && (
                <div><dt>Model-size variant</dt><dd>{shownDetails.value.llm.width}×{shownDetails.value.llm.height} WebP · {formatBytes(shownDetails.value.llm.byteLength)}</dd></div>
              )}
            </>
          )}
          {shownDetails?.failed && <div><dt>Details</dt><dd>Unavailable</dd></div>}
        </dl>
        <p className="obs-media-galleryhint" aria-hidden>Esc to close · ← → to browse</p>
      </div>
    </div>
  );
}
