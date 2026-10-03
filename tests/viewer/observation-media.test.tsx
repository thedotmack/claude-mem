import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ObservationCard } from '../../src/ui/viewer/components/ObservationCard';
import { MediaLightboxDialog, ObservationMediaStripView } from '../../src/ui/viewer/components/ObservationMedia';
import { formatDate } from '../../src/ui/viewer/utils/formatters';
import {
  MAX_CARD_THUMBNAILS,
  canRetryMediaState,
  galleryKeyAction,
  mediaDisplayStateFrom,
  nextFocusIndex,
  shouldPollMediaState,
  type MediaDisplayState,
} from '../../src/ui/viewer/utils/media';
import type { MediaMetadataResponse, Observation, ObservationMedia } from '../../src/ui/viewer/types';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const baseObservation: Observation = {
  id: 42, memory_session_id: 'mem-1', content_session_id: 'content-1', project: 'demo', platform_source: 'claude',
  type: 'discovery', title: 'Found the bug', subtitle: 'In the parser', narrative: 'A narrative.', text: null,
  facts: JSON.stringify(['fact one']), concepts: JSON.stringify(['how-it-works']),
  files_read: JSON.stringify(['/Users/x/demo/src/a.ts']), files_modified: JSON.stringify([]),
  prompt_number: 1, created_at: '2026-10-02T00:00:00.000Z', created_at_epoch: 1790000000000,
};
const mediaWith = (count: number, overflow?: boolean): ObservationMedia => ({
  version: 1,
  attachments: Array.from({ length: count }, (_, index) => ({
    id: uuid(index + 1), label: `event1_image${(index % 4) + 1}`, inspection: index === 0 ? 'inspected' : 'uninspected',
  })),
  ...(overflow ? { overflow } : {}),
});
const readyMetadata = (id: string): MediaMetadataResponse => ({
  id, state: 'ready', recipe: 'screenshot-v1', encoderVersion: 'sharp-0.34/vips-8.17',
  viewer: { sha256: 'a'.repeat(64), width: 1280, height: 720, byteLength: 204800, mimeType: 'image/webp' },
  llm: { sha256: 'b'.repeat(64), width: 1280, height: 720, byteLength: 102400, mimeType: 'image/webp' },
  failureCode: null, capturedAt: 1790000000000,
});
const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const noop = () => {};
// Never in any generic rendering: locators, raw URLs, provenance internals.
const FORBIDDEN = ['/Users/', 'file://', 'data:image', 'source_pointer', 'sourceLocatorPath', 'http://', 'https://'];

describe('image-free observations', () => {
  it('render exactly the pre-media markup', () => {
    // Captured from ObservationCard at 22a2a1853, before Phase 6.
    const before = '<div class="card"><div class="card-header"><div class="card-header-left"><span class="card-type type-discovery">discovery</span><span class="card-source source-claude">claude</span><span class="card-project">demo</span></div><div class="view-mode-toggles"><button class="view-mode-toggle "><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg><span>facts</span></button><button class="view-mode-toggle "><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg><span>narrative</span></button><button class="card-delete-btn" title="Delete observation" aria-label="Delete observation"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button></div></div><div class="card-title">Found the bug</div><div class="view-mode-content"><div class="card-subtitle">In the parser</div></div><div class="card-meta"><span class="meta-date">#42 • DATE</span></div></div>'
      .replace('DATE', formatDate(baseObservation.created_at_epoch));
    expect(render(<ObservationCard observation={baseObservation} onDeleted={noop} />)).toBe(before);
    // An empty ref set renders the same way.
    expect(render(<ObservationCard observation={{ ...baseObservation, media: { version: 1, attachments: [] } }} onDeleted={noop} />)).toBe(before);
  });
});

describe('thumbnail strip', () => {
  it('bounds thumbnails, counts the rest and labels every tile from its request label', () => {
    const media = mediaWith(6, true);
    const states: Record<string, MediaDisplayState> = { [uuid(1)]: { kind: 'ready', metadata: readyMetadata(uuid(1)) }, [uuid(2)]: { kind: 'downloading' } };
    const html = render(<ObservationMediaStripView observationId={42} media={media} states={states} onOpen={noop} onRetry={noop} onImageError={noop} />);
    expect(html.match(/class="media-thumb-button"/g)).toHaveLength(MAX_CARD_THUMBNAILS);
    expect(html).toContain('+2');
    expect(html).toContain('6 images (more on the source event)');
    expect(html).toContain('alt="Image event1_image1 (1 of 6) attached to observation #42"');
    expect(html).toContain('src="/api/media/00000001-0000-4000-8000-000000000000/llm"');
    expect(html).toContain('Downloading…');
    expect(html).not.toContain('Failed');
    expect(html).toContain('Loading…');
    expect(html.match(/not inspected/g)).toHaveLength(3);
    for (const forbidden of FORBIDDEN) expect(html).not.toContain(forbidden);
  });

  it('a card with refs renders the strip in loading state before metadata resolves', () => {
    const html = render(<ObservationCard observation={{ ...baseObservation, media: mediaWith(1) }} onDeleted={noop} />);
    expect(html).toContain('class="media-strip"');
    expect(html).toContain('Loading…');
    expect(html).not.toContain('<img');
    expect(html).toContain('1 image</span>');
  });

  it('shows rejected, failed, removed and retryable error states', () => {
    const media = mediaWith(4);
    const states: Record<string, MediaDisplayState> = {
      [uuid(1)]: { kind: 'rejected', code: 'pixel_limit' },
      [uuid(2)]: { kind: 'failed', code: 'conversion_timeout' },
      [uuid(3)]: { kind: 'unavailable' },
      [uuid(4)]: { kind: 'error', code: 'storage_unavailable' },
    };
    const html = render(<ObservationMediaStripView observationId={7} media={media} states={states} onOpen={noop} onRetry={noop} onImageError={noop} />);
    expect(html).toContain('Rejected (pixel_limit)');
    expect(html).toContain('Failed (conversion_timeout)');
    expect(html).toContain('Image removed');
    expect(html).toContain('Couldn’t load');
    expect(html.match(/>Retry</g)).toHaveLength(1);
    expect(html).not.toContain('<img');
  });
});

describe('readiness mapping from the controlled metadata route', () => {
  it('maps every route outcome to a display state', () => {
    expect(mediaDisplayStateFrom(200, readyMetadata(uuid(1))).kind).toBe('ready');
    expect(mediaDisplayStateFrom(200, { state: 'converting' })).toEqual({ kind: 'pending' });
    // A second-device replica is downloading, never a failure.
    expect(mediaDisplayStateFrom(200, { state: 'unresolved_replica', failureCode: null })).toEqual({ kind: 'downloading' });
    expect(mediaDisplayStateFrom(200, { state: 'failed', failureCode: 'pixel_limit' })).toEqual({ kind: 'rejected', code: 'pixel_limit' });
    expect(mediaDisplayStateFrom(200, { state: 'failed', failureCode: 'conversion_timeout' })).toEqual({ kind: 'failed', code: 'conversion_timeout' });
    expect(mediaDisplayStateFrom(200, { state: 'failed', failureCode: '/etc/passwd' })).toEqual({ kind: 'failed', code: 'storage_unavailable' });
    expect(mediaDisplayStateFrom(404, { code: 'media_not_found' })).toEqual({ kind: 'unavailable' });
    expect(mediaDisplayStateFrom(409, { code: 'media_not_ready' })).toEqual({ kind: 'pending' });
    expect(mediaDisplayStateFrom(503, { code: 'storage_unavailable' })).toEqual({ kind: 'error', code: 'storage_unavailable' });
    expect(mediaDisplayStateFrom(403, { code: 'unauthorized_owner' })).toEqual({ kind: 'error', code: 'unauthorized_owner' });
    expect(mediaDisplayStateFrom(0, null)).toEqual({ kind: 'error', code: 'network_error' });
  });

  it('polls only pending and downloading attachments', () => {
    expect(shouldPollMediaState({ kind: 'pending' })).toBe(true);
    expect(shouldPollMediaState({ kind: 'downloading' })).toBe(true);
    for (const state of [{ kind: 'unavailable' }, { kind: 'error', code: 'x' }, { kind: 'rejected', code: 'pixel_limit' }] as MediaDisplayState[]) {
      expect(shouldPollMediaState(state)).toBe(false);
    }
  });
});

describe('gallery keyboard and focus', () => {
  it('Escape closes, arrows move without wrapping, Home/End jump', () => {
    expect(galleryKeyAction('Escape', 1, 3)).toEqual({ type: 'close' });
    expect(galleryKeyAction('ArrowRight', 0, 3)).toEqual({ type: 'show', index: 1 });
    expect(galleryKeyAction('ArrowRight', 2, 3)).toBeNull();
    expect(galleryKeyAction('ArrowLeft', 2, 3)).toEqual({ type: 'show', index: 1 });
    expect(galleryKeyAction('ArrowLeft', 0, 3)).toBeNull();
    expect(galleryKeyAction('Home', 2, 3)).toEqual({ type: 'show', index: 0 });
    expect(galleryKeyAction('End', 0, 3)).toEqual({ type: 'show', index: 2 });
    expect(galleryKeyAction('Enter', 0, 3)).toBeNull();
  });

  it('Tab focus wraps inside the dialog in both directions', () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
    expect(nextFocusIndex(-1, 0, false)).toBe(-1);
  });
});

describe('lightbox dialog', () => {
  const refs = mediaWith(3).attachments;
  const dialog = (state: MediaDisplayState, index = 0, ownerDetails: Parameters<typeof MediaLightboxDialog>[0]['ownerDetails'] = null) => render(
    <MediaLightboxDialog observationId={42} refs={refs} index={index} state={state} ownerDetails={ownerDetails}
      onClose={noop} onShow={noop} onRetry={noop} onImageError={noop} onRequestOwnerDetails={noop} />,
  );

  it('is a labelled modal with the full viewer image, alt text and provenance, but no locator', () => {
    const html = dialog({ kind: 'ready', metadata: readyMetadata(uuid(1)) });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Close image viewer"');
    expect(html).toContain('src="/api/media/00000001-0000-4000-8000-000000000000/viewer"');
    expect(html).toContain('alt="Image event1_image1 (1 of 3) attached to observation #42"');
    expect(html).toContain('Image 1 of 3');
    expect(html).toContain('screenshot-v1');
    expect(html).toContain('1280 × 720');
    expect(html).toContain('200.0 KiB');
    expect(html).toContain(formatDate(1790000000000));
    expect(html).toContain('Inspected by the observer');
    // Source availability comes only from the owner-only details route.
    expect(html).not.toContain('Source file');
    expect(html).toContain('Show source details');
    // First image: previous is disabled; next is enabled.
    expect(html).toMatch(/aria-label="Previous image" disabled=""/);
    expect(html).not.toMatch(/aria-label="Next image" disabled=""/);
    for (const forbidden of FORBIDDEN) expect(html).not.toContain(forbidden);
  });

  it('shows the owner-only locator only after an explicit details request', () => {
    const html = dialog({ kind: 'ready', metadata: readyMetadata(uuid(2)) }, 1, {
      id: uuid(2), platform: 'claude-code', sourceShape: 'trusted_tool_file',
      sourceLocatorPath: '/Users/me/shot.png', sourceAvailability: 'file_missing',
    });
    expect(html).toContain('/Users/me/shot.png');
    expect(html).toContain('Source file no longer available; converted copy retained');
    expect(html).toContain('Not inspected (stored only)');
    expect(html).not.toContain('Show source details');
  });

  it('labels a replica as synced from another device, never as an inline image', () => {
    const html = dialog({ kind: 'ready', metadata: readyMetadata(uuid(3)) }, 2, {
      id: uuid(3), platform: null, sourceShape: null, sourceLocatorPath: null, sourceAvailability: 'converted_only',
    });
    expect(html).toContain('Synced from another device; converted copy retained');
    expect(html).not.toContain('inline image');
    expect(html).not.toContain('Source file<');
  });

  it('offers Retry once bounded polling of a pending or downloading image stops', () => {
    expect(canRetryMediaState({ kind: 'pending' })).toBe(false);
    expect(canRetryMediaState({ kind: 'downloading' })).toBe(false);
    expect(canRetryMediaState({ kind: 'pending', stalled: true })).toBe(true);
    expect(canRetryMediaState({ kind: 'downloading', stalled: true })).toBe(true);
    const stalled = dialog({ kind: 'downloading', stalled: true });
    expect(stalled).toContain('Still downloading');
    expect(stalled).toContain('>Retry<');
    const strip = render(<ObservationMediaStripView observationId={1} media={mediaWith(2)} onOpen={noop} onRetry={noop} onImageError={noop}
      states={{ [uuid(1)]: { kind: 'pending', stalled: true }, [uuid(2)]: { kind: 'pending' } }} />);
    expect(strip).toContain('Still processing');
    expect(strip.match(/>Retry</g)).toHaveLength(1);
  });

  it('renders loading, pending and error states without an image, with retry on error', () => {
    expect(dialog({ kind: 'loading' })).toContain('Loading…');
    expect(dialog({ kind: 'downloading' }, 2)).toContain('Downloading…');
    expect(dialog({ kind: 'downloading' }, 2)).toMatch(/aria-label="Next image" disabled=""/);
    const error = dialog({ kind: 'error', code: 'storage_unavailable' });
    expect(error).toContain('Couldn’t load');
    expect(error).toContain('>Retry<');
    expect(error).not.toContain('<img');
    expect(error).not.toContain('Show source details');
  });
});
