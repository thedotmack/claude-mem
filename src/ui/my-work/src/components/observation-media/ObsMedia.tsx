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
//   - 16.0.0 (c-obs-media): every word goes through the reader's language; the
//     strip says in words how many images the agent has not read, with a line
//     saying what the corner ring means; the viewer opens with the image's
//     state and whether the agent read it ("Saved. The agent has not read
//     this image.", "Deleted. …") and folds the recipe, encoder, sizes and
//     file name under "Technical details"; Close, Previous and Next are 44px;
//     every button is the app's Button (G14).
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
import { ChevronLeft, ChevronRight, Eye, EyeOff, Image as ImageIcon, X } from 'lucide-react';

import { workerMediaSource } from './worker-media-source';
import { setTimeoutThenWaitUntilCloudPageVisible } from '@/live/served-from';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible';
import { interpolate, useI18n } from '@/lib/i18n';
import {
  altText,
  displayState,
  formatBytes,
  galleryKeyAction,
  inspectionCopy,
  inspectionLead,
  provenanceDetails,
  STATE_WORDS,
  THUMBNAIL_LIMIT,
  trapFocusIndex,
  type MediaDisplayState,
  type ProvenanceDetails,
  type ServerMediaState,
  type Translate,
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

/** How many images, in words: "1 image", "8 images". */
function imageCount(count: number, t: Translate): string {
  return interpolate(count === 1 ? t('{count} image') : t('{count} images'), { count });
}

/** `count`: the request's distinct images when `media` is only its card preview. */
export function MediaCountBadge({ media, count }: { media?: VMedia; count?: number }) {
  const { t } = useI18n();
  const total = count ?? media?.attachments.length ?? 0;
  if (!media || total === 0) return null;
  const label = media.overflow ? interpolate(t('{images} (more on the source event)'), { images: imageCount(total, t) }) : imageCount(total, t);
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
  const { t } = useI18n();
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
    <div className="obs-media" aria-label={count === 1 ? t('1 attached image') : interpolate(t('{count} attached images'), { count })} role="group">
      <div className="obs-media-head">
        <span>
          {imageCount(count, t)}
          {media?.overflow ? ` · ${t('more on the source event')}` : ''}
        </span>
        {/* How many the agent has not read, in words (c-obs-media M: it was a corner dot whose meaning was a hover title). */}
        {uninspected > 0 && <span className="obs-media-tag"><EyeOff size={13} strokeWidth={2} aria-hidden />{interpolate(t('{count} not read by the agent'), { count: uninspected })}</span>}
      </div>
      <div className="obs-media-strip">
        {visible.map((ref, index) => {
          const state = thumbnailStateOf(ref);
          return (
            <Button
              key={ref.id}
              variant="bare"
              className="obs-media-thumb justify-center"
              data-state={state}
              onClick={(event) => open(index, event.currentTarget)}
              aria-label={interpolate(t('Open image {current} of {total} ({label}): {state}, {inspection}'), { current: index + 1, total: count, label: ref.label, state: STATE_WORDS[state](t), inspection: inspectionCopy(ref.inspection, t) })}
            >
              {state === 'ready' ? (
                <img
                  key={loadAttempt}
                  src={source.thumbnailUrl(ref.id)}
                  alt={altText(ref, index, refs.length, title, t)}
                  // The thumbnail's box (index.css .obs-media-thumb), so its room is known before the bytes arrive.
                  width={88}
                  height={64}
                  loading="lazy"
                  decoding="async"
                  onError={() => markThumbnailBroken(ref.id)}
                />
              ) : (
                <span className="obs-media-state">{STATE_WORDS[state](t)}</span>
              )}
              {ref.inspection === 'uninspected' && <span className="obs-media-dot" aria-hidden />}
            </Button>
          );
        })}
        {hidden > 0 && (!partial || onMore) && (
          <Button
            variant="bare"
            className="obs-media-more justify-center"
            onClick={(event) => (partial ? onMore?.() : open(THUMBNAIL_LIMIT, event.currentTarget))}
            aria-label={hidden === 1 ? t('Show 1 more image') : interpolate(t('Show {count} more images'), { count: hidden })}
          >
            {interpolate(t('+{count} more'), { count: hidden })}
          </Button>
        )}
      </div>
      {/* What the corner ring means, said once under the strip (c-obs-media M: a legend for the corner mark). */}
      {visible.some((ref) => ref.inspection === 'uninspected') && (
        <p className="obs-media-legend"><span className="obs-media-dot" aria-hidden />{t('A ring in the corner marks an image the agent has not read.')}</p>
      )}
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

/** What the viewer says in place of an image it cannot show, one sentence per state. */
const GALLERY_STATE_WORDS: Record<MediaDisplayState, (t: Translate) => string> = {
  checking: (t) => t('Checking…'),
  pending: (t) => t('Processing… The image is still being converted or downloaded.'),
  ready: (t) => t('Ready'),
  deleted: (t) => t('Deleted. This image was deleted.'),
  rejected: (t) => t('Rejected. The image could not be stored: unsupported, out of bounds, or the conversion failed.'),
  failed: (t) => t('Could not load. The image could not be loaded or verified.'),
  unavailable: (t) => t('Unavailable. The image’s status could not be read.'),
};

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
  const { t } = useI18n();
  const source = useContext(MediaSourceContext);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
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
  const viewer = shownDetails?.value?.viewer;
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
          <h2 id={headingId}>{interpolate(t('Image {current} of {total}'), { current: index + 1, total: refs.length })}</h2>
          <Button ref={closeRef} variant="bare" className="obs-media-galleryclose" onClick={onClose} aria-label={t('Close image viewer (Escape)')}>
            <X size={18} strokeWidth={2} aria-hidden />
          </Button>
        </header>
        <div className="obs-media-galleryframe" data-state={state}>
          {refs.length > 1 && (
            <Button variant="bare" className="obs-media-gallerynav is-prev" onClick={() => onIndex((index - 1 + refs.length) % refs.length)} aria-label={t('Previous image')}>
              <ChevronLeft size={20} strokeWidth={2} aria-hidden />
            </Button>
          )}
          {state === 'ready' ? (
            <img key={`${ref.id}:${loadAttempt}`} src={source.imageUrl(ref.id)} alt={altText(ref, index, refs.length, title, t)} onError={() => onBroken(ref.id)} />
          ) : (
            <div className="obs-media-gallerystate">
              <p role="status">{GALLERY_STATE_WORDS[state](t)}</p>
              {state === 'failed' && (
                <Button
                  variant="bare"
                  className="obs-media-galleryretry"
                  onClick={() => {
                    // This button unmounts once the failure clears; keep focus inside the dialog.
                    closeRef.current?.focus();
                    onRetry(ref.id);
                  }}
                >
                  {t('Try again')}
                </Button>
              )}
            </div>
          )}
          {refs.length > 1 && (
            <Button variant="bare" className="obs-media-gallerynav is-next" onClick={() => onIndex((index + 1) % refs.length)} aria-label={t('Next image')}>
              <ChevronRight size={20} strokeWidth={2} aria-hidden />
            </Button>
          )}
        </div>
        {/* The one fact the owner may care about comes first, in words; the developer's facts fold below (c-obs-media M). */}
        <p className="obs-media-lead" id={detailsId}>
          {ref.inspection === 'uninspected' ? <EyeOff size={16} strokeWidth={2} aria-hidden /> : <Eye size={16} strokeWidth={2} aria-hidden />}
          <span>{inspectionLead(state, ref.inspection, t)}</span>
          {viewer && <span className="obs-media-size">{viewer.width} × {viewer.height} · {formatBytes(viewer.byteLength)}</span>}
        </p>
        <Collapsible>
          <CollapsibleFoldTrigger>{t('Technical details')}</CollapsibleFoldTrigger>
          <CollapsibleContent>
            <dl className="obs-media-gallerydetails">
              <div><dt>{t('State')}</dt><dd>{STATE_WORDS[state](t)}</dd></div>
              <div><dt>{t('Agent')}</dt><dd>{inspectionCopy(ref.inspection, t)}</dd></div>
              <div><dt>{t('Name')}</dt><dd>{ref.label}</dd></div>
              {shownDetails?.value && (
                <>
                  <div><dt>{t('Recipe')}</dt><dd>{shownDetails.value.recipe}</dd></div>
                  <div><dt>{t('Encoder')}</dt><dd>{shownDetails.value.encoder}</dd></div>
                  {shownDetails.value.viewer && (
                    <div><dt>{t('Kept size')}</dt><dd>{shownDetails.value.viewer.width}×{shownDetails.value.viewer.height} WebP · {formatBytes(shownDetails.value.viewer.byteLength)}</dd></div>
                  )}
                  {shownDetails.value.llm && (
                    <div><dt>{t('Size the agent reads')}</dt><dd>{shownDetails.value.llm.width}×{shownDetails.value.llm.height} WebP · {formatBytes(shownDetails.value.llm.byteLength)}</dd></div>
                  )}
                </>
              )}
              {shownDetails?.failed && <div><dt>{t('Details')}</dt><dd>{t('Unavailable')}</dd></div>}
            </dl>
          </CollapsibleContent>
        </Collapsible>
        <p className="obs-media-galleryhint" aria-hidden>{t('Esc closes · ← → browse')}</p>
      </div>
    </div>
  );
}
