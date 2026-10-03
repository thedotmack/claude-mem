import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MediaOwnerDetailsResponse, ObservationMedia, ObservationMediaRef } from '../types';
import { useMediaStates } from '../hooks/useMediaStates';
import { formatDate } from '../utils/formatters';
import {
  MAX_CARD_THUMBNAILS,
  canRetryMediaState,
  formatMediaBytes,
  galleryKeyAction,
  inspectionText,
  mediaAltText,
  mediaOwnerDetailsUrl,
  mediaStatusText,
  mediaVariantUrl,
  nextFocusIndex,
  sourceAvailabilityText,
  type MediaDisplayState,
} from '../utils/media';

const LOADING: MediaDisplayState = { kind: 'loading' };

interface StripViewProps {
  observationId: number;
  media: ObservationMedia;
  states: Record<string, MediaDisplayState>;
  onOpen: (index: number, opener: HTMLElement) => void;
  onRetry: (id: string) => void;
  onImageError: (id: string) => void;
}

/**
 * Bounded thumbnail strip: at most MAX_CARD_THUMBNAILS tiles, the last one
 * carrying a "+N" count when more images exist. Every tile opens the gallery.
 */
export function ObservationMediaStripView({ observationId, media, states, onOpen, onRetry, onImageError }: StripViewProps) {
  const refs = media.attachments;
  const visible = refs.slice(0, MAX_CARD_THUMBNAILS);
  const hiddenCount = refs.length - visible.length;
  return (
    <div className="media-strip" role="group" aria-label={`${refs.length} image${refs.length === 1 ? '' : 's'} attached`}>
      {visible.map((ref, index) => {
        const state = states[ref.id] ?? LOADING;
        const isLastWithMore = index === visible.length - 1 && hiddenCount > 0;
        const alt = mediaAltText(ref, index, refs.length, observationId);
        return (
          <div key={ref.id} className={`media-thumb media-thumb--${state.kind}`}>
            <button
              type="button"
              className="media-thumb-button"
              aria-label={`Open ${alt}${isLastWithMore ? ` and ${hiddenCount} more` : ''}`}
              onClick={event => onOpen(index, event.currentTarget)}
            >
              {state.kind === 'ready' ? (
                <img
                  src={mediaVariantUrl(ref.id, 'llm')}
                  alt={alt}
                  loading="lazy"
                  decoding="async"
                  width={state.metadata.llm?.width}
                  height={state.metadata.llm?.height}
                  onError={() => onImageError(ref.id)}
                />
              ) : (
                <span className="media-thumb-status">{mediaStatusText(state)}</span>
              )}
              {ref.inspection === 'uninspected' && <span className="media-thumb-badge">not inspected</span>}
              {isLastWithMore && <span className="media-thumb-more">+{hiddenCount}</span>}
            </button>
            {canRetryMediaState(state) && (
              <button type="button" className="media-thumb-retry" onClick={() => onRetry(ref.id)}>Retry</button>
            )}
          </div>
        );
      })}
      <span className="media-strip-count">
        {refs.length} image{refs.length === 1 ? '' : 's'}
        {media.overflow ? ' (more on the source event)' : ''}
      </span>
    </div>
  );
}

interface DialogViewProps {
  observationId: number;
  refs: ObservationMediaRef[];
  index: number;
  state: MediaDisplayState;
  ownerDetails: MediaOwnerDetailsResponse | 'loading' | 'error' | null;
  onClose: () => void;
  onShow: (index: number) => void;
  onRetry: (id: string) => void;
  onImageError: (id: string) => void;
  onRequestOwnerDetails: () => void;
}

/** The dialog body, without portal or document effects (renderable on the server for tests). */
export function MediaLightboxDialog({ observationId, refs, index, state, ownerDetails, onClose, onShow, onRetry, onImageError, onRequestOwnerDetails }: DialogViewProps) {
  const ref = refs[index];
  const alt = mediaAltText(ref, index, refs.length, observationId);
  const metadata = state.kind === 'ready' ? state.metadata : null;
  const titleId = `media-lightbox-title-${observationId}`;
  return (
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="media-lightbox-header">
        <h2 id={titleId} className="media-lightbox-title">
          Image {index + 1} of {refs.length} <span className="media-lightbox-label">{ref.label}</span>
        </h2>
        <button type="button" className="modal-close-btn media-lightbox-close" aria-label="Close image viewer" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div className="media-lightbox-stage">
        <button type="button" className="media-lightbox-nav" aria-label="Previous image" disabled={index === 0} onClick={() => onShow(index - 1)}>‹</button>
        <div className="media-lightbox-frame" aria-live="polite">
          {metadata ? (
            <img
              src={mediaVariantUrl(ref.id, 'viewer')}
              alt={alt}
              width={metadata.viewer?.width}
              height={metadata.viewer?.height}
              onError={() => onImageError(ref.id)}
            />
          ) : (
            <div className={`media-lightbox-status media-thumb--${state.kind}`}>
              <span>{mediaStatusText(state)}</span>
              {canRetryMediaState(state) && <button type="button" className="media-thumb-retry" onClick={() => onRetry(ref.id)}>Retry</button>}
            </div>
          )}
        </div>
        <button type="button" className="media-lightbox-nav" aria-label="Next image" disabled={index === refs.length - 1} onClick={() => onShow(index + 1)}>›</button>
      </div>
      <dl className="media-lightbox-provenance">
        <dt>Inspection</dt><dd>{inspectionText(ref)}</dd>
        <dt>Status</dt><dd>{mediaStatusText(state)}</dd>
        {metadata && (
          <>
            <dt>Recipe</dt><dd>{metadata.recipe}</dd>
            {metadata.viewer && (
              <>
                <dt>Dimensions</dt><dd>{metadata.viewer.width} × {metadata.viewer.height}</dd>
                <dt>Size</dt><dd>{formatMediaBytes(metadata.viewer.byteLength)} (WebP)</dd>
              </>
            )}
            <dt>Captured</dt><dd>{formatDate(metadata.capturedAt)}</dd>
          </>
        )}
      </dl>
      {metadata && (
        <div className="media-lightbox-owner">
          {ownerDetails === null && (
            <button type="button" className="view-mode-toggle" onClick={onRequestOwnerDetails}>Show source details</button>
          )}
          {ownerDetails === 'loading' && <span>Loading source details…</span>}
          {ownerDetails === 'error' && <span>Source details unavailable</span>}
          {ownerDetails && typeof ownerDetails === 'object' && (
            <dl className="media-lightbox-provenance">
              <dt>Source</dt><dd>{sourceAvailabilityText(ownerDetails)}</dd>
              {ownerDetails.platform !== null && (
                <>
                  <dt>Platform</dt><dd>{ownerDetails.platform}</dd>
                  <dt>Source shape</dt><dd>{ownerDetails.sourceShape}</dd>
                  <dt>Source file</dt><dd className="media-lightbox-path">{ownerDetails.sourceLocatorPath ?? 'none (inline image)'}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

interface LightboxProps {
  observationId: number;
  refs: ObservationMediaRef[];
  initialIndex: number;
  states: Record<string, MediaDisplayState>;
  opener: HTMLElement | null;
  onClose: () => void;
  onRetry: (id: string) => void;
  onImageError: (id: string) => void;
}

/** Modal gallery: focus moves in on open, is trapped while open, and returns to the opener. */
function MediaLightbox({ observationId, refs, initialIndex, states, opener, onClose, onRetry, onImageError }: LightboxProps) {
  const [index, setIndex] = useState(initialIndex);
  const [ownerDetails, setOwnerDetails] = useState<Record<string, MediaOwnerDetailsResponse | 'loading' | 'error'>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const ref = refs[index];

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    containerRef.current?.querySelector<HTMLElement>('.media-lightbox-close')?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [opener]);

  // A control that just disappeared or became disabled (a nav button at the
  // end, the source-details button once loaded, a status that turned into an
  // image) drops focus to <body>. After every render, pull it back inside.
  useEffect(() => {
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) container.querySelector<HTMLElement>('.media-lightbox')?.focus();
  });

  // Listen on the document so Escape and the arrows work wherever focus is.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const focusable = Array.from(containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        const next = nextFocusIndex(focusable.indexOf(document.activeElement as HTMLElement), focusable.length, event.shiftKey);
        if (next >= 0) {
          event.preventDefault();
          focusable[next].focus();
        }
        return;
      }
      const action = galleryKeyAction(event.key, index, refs.length);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'close') onClose();
      else setIndex(action.index);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [index, refs.length, onClose]);

  const requestOwnerDetails = useCallback(async () => {
    const id = ref.id;
    setOwnerDetails(previous => ({ ...previous, [id]: 'loading' }));
    try {
      const response = await fetch(mediaOwnerDetailsUrl(id), { credentials: 'same-origin' });
      const body = response.ok ? await response.json() as MediaOwnerDetailsResponse : null;
      setOwnerDetails(previous => ({ ...previous, [id]: body ?? 'error' }));
    } catch {
      setOwnerDetails(previous => ({ ...previous, [id]: 'error' }));
    }
  }, [ref.id]);

  return createPortal(
    <div
      className="modal-backdrop media-lightbox-backdrop"
      ref={containerRef}
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <MediaLightboxDialog
        observationId={observationId}
        refs={refs}
        index={index}
        state={states[ref.id] ?? LOADING}
        ownerDetails={ownerDetails[ref.id] ?? null}
        onClose={onClose}
        onShow={setIndex}
        onRetry={onRetry}
        onImageError={onImageError}
        onRequestOwnerDetails={() => { void requestOwnerDetails(); }}
      />
    </div>,
    document.body,
  );
}

/** Card section for an observation with media refs; image-free rows never render it. */
export function ObservationMediaSection({ observationId, media }: { observationId: number; media: ObservationMedia }) {
  const ids = media.attachments.map(ref => ref.id);
  const { states, retry, markImageError } = useMediaStates(ids);
  const [open, setOpen] = useState<{ index: number; opener: HTMLElement } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <>
      <ObservationMediaStripView
        observationId={observationId}
        media={media}
        states={states}
        onOpen={(index, opener) => setOpen({ index, opener })}
        onRetry={retry}
        onImageError={markImageError}
      />
      {open && (
        <MediaLightbox
          observationId={observationId}
          refs={media.attachments}
          initialIndex={open.index}
          states={states}
          opener={open.opener}
          onClose={close}
          onRetry={retry}
          onImageError={markImageError}
        />
      )}
    </>
  );
}
