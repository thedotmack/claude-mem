// My Work's port of PR #265's observation gallery (src/ui/my-work/src/components/observation-media):
// the worker URLs it builds, the readiness polling (including PR #265's "status failures never retry"
// review thread), the status batching, and server-rendered markup for cards, drawers and image-free rows.
import { describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { MEDIA_LIMITS } from '../../../src/shared/media-contract.js';

const MY_WORK = resolve(import.meta.dir, '../../../src/ui/my-work');
const GALLERY_DIR = join(MY_WORK, 'src/components/observation-media');

// Compile the real components with the app's own React, as hosted-setup.test.ts does.
const compiled = buildSync({
  stdin: {
    resolveDir: MY_WORK, loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { MediaCountBadge, ObsMediaStrip, MediaSourceContext, watchMediaStatus } from './src/components/observation-media/ObsMedia';
      import { SAMPLE_MEDIA_SOURCE } from './src/components/observation-media/sample-media';
      import { requestImages } from './src/components/observation-media/request-images';
      export * from './src/components/observation-media/media';
      export { createWorkerMediaSource, statusChunks } from './src/components/observation-media/worker-media-source';
      export { SAMPLE_MEDIA_REFS } from './src/components/observation-media/sample-media';
      export { SAMPLE_REQUESTS } from './src/data';
      export { watchMediaStatus, requestImages };
      export const renderStrip = (props) => renderToStaticMarkup(<ObsMediaStrip {...props} />);
      export const renderBadge = (props) => renderToStaticMarkup(<MediaCountBadge {...props} />);
      export const renderWithSample = (props) => renderToStaticMarkup(<MediaSourceContext.Provider value={SAMPLE_MEDIA_SOURCE}><ObsMediaStrip {...props} /></MediaSourceContext.Provider>);
    `,
  },
  tsconfig: join(MY_WORK, 'tsconfig.app.json'),
  bundle: true, write: false, format: 'cjs', platform: 'node',
  loader: { '.webp': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;
const gallery = (() => {
  const module = { exports: {} as any };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
})();

const uuid = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const refs = (count: number, inspection: 'inspected' | 'uninspected' = 'inspected') =>
  Array.from({ length: count }, (_, index) => ({ id: uuid(index + 1), label: `event1_image${(index % 4) + 1}`, inspection }));

describe('worker media URLs', () => {
  it('point only at the worker media routes, never Pro routes or owner details', () => {
    expect(gallery.mediaThumbnailUrl(uuid(1))).toBe(`/api/media/${uuid(1)}/llm`);
    expect(gallery.mediaViewerUrl(uuid(1))).toBe(`/api/media/${uuid(1)}/viewer`);
    expect(gallery.mediaDescriptorUrl(uuid(1))).toBe(`/api/media/${uuid(1)}`);
    expect(gallery.mediaStatusUrl([uuid(1), uuid(2)])).toBe(`/api/media/status?ids=${uuid(1)},${uuid(2)}`);
    expect(gallery.MEDIA_FETCH_INIT).toEqual({ credentials: 'same-origin', cache: 'no-store' });
  });

  it('refuses anything that is not a v4 attachment id, and status lists outside 1..32', () => {
    for (const bad of ['../settings', 'x', `${uuid(1)}/details`, uuid(1).toUpperCase()]) {
      expect(() => gallery.mediaThumbnailUrl(bad)).toThrow('invalid attachment id');
    }
    expect(() => gallery.mediaStatusUrl([])).toThrow();
    expect(gallery.MEDIA_STATUS_MAX_IDS).toBe(MEDIA_LIMITS.maxObservationRefs);
    expect(() => gallery.mediaStatusUrl(refs(MEDIA_LIMITS.maxObservationRefs + 1).map(ref => ref.id))).toThrow();
  });

  it('no gallery file names a Pro media route or the owner details route', () => {
    for (const name of readdirSync(GALLERY_DIR)) {
      const source = readFileSync(join(GALLERY_DIR, name), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
      expect(source).not.toContain('/api/observation-media');
      expect(source).not.toContain('/details');
    }
  });
});

describe('route answers', () => {
  it('keeps only requested ids in the four states', () => {
    const states = gallery.parseStatusResponse({ attachments: [
      { id: uuid(1), state: 'ready' }, { id: uuid(2), state: 'converting' }, { id: uuid(9), state: 'ready' }, { id: uuid(3), state: 'rejected' },
    ] }, [uuid(1), uuid(2), uuid(3)]);
    expect([...states]).toEqual([[uuid(1), 'ready'], [uuid(3), 'rejected']]);
    expect(gallery.parseStatusResponse(null, [uuid(1)]).size).toBe(0);
  });

  it('reads provenance from the worker metadata body and drops hashes', () => {
    const details = gallery.provenanceDetails({
      id: uuid(1), state: 'ready', recipe: 'screenshot-v1', encoderVersion: 'sharp-0.34/vips-8.17',
      viewer: { sha256: 'a'.repeat(64), width: 1280, height: 720, byteLength: 204800, mimeType: 'image/webp' }, llm: null,
    });
    expect(details).toEqual({ recipe: 'screenshot-v1', encoder: 'sharp-0.34/vips-8.17', viewer: { width: 1280, height: 720, byteLength: 204800 }, llm: null });
    expect(gallery.provenanceDetails({ recipe: 'screenshot-v1' })).toBeNull();
  });

  it('keeps PR #265 keyboard rules: Esc closes, arrows wrap, Home/End jump, Tab is trapped', () => {
    expect(gallery.galleryKeyAction('Escape', 0, 3)).toEqual({ type: 'close' });
    expect(gallery.galleryKeyAction('ArrowRight', 2, 3)).toEqual({ type: 'go', index: 0 });
    expect(gallery.galleryKeyAction('ArrowLeft', 0, 3)).toEqual({ type: 'go', index: 2 });
    expect(gallery.galleryKeyAction('End', 0, 3)).toEqual({ type: 'go', index: 2 });
    expect(gallery.galleryKeyAction('a', 0, 3)).toBeNull();
    expect(gallery.trapFocusIndex(2, 3, false)).toBe(0);
    expect(gallery.trapFocusIndex(0, 3, true)).toBe(2);
  });
});

describe('readiness polling', () => {
  /** A fake timer: records each scheduled recheck so the test runs them by hand. */
  function scheduler() {
    const queue: Array<() => void> = [];
    return { queue, schedule: (recheck: () => void) => { queue.push(recheck); return () => {}; } };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('rechecks after a failed status call, so images appear when the worker recovers (PR #265 review thread)', async () => {
    const { queue, schedule } = scheduler();
    const results: any[] = [];
    let calls = 0;
    const status = async () => {
      calls += 1;
      if (calls === 1) throw new Error('status 503');
      return new Map([[uuid(1), 'ready']]);
    };
    gallery.watchMediaStatus([uuid(1)], status, (result: unknown) => results.push(result), schedule);
    await settle();
    expect(results).toEqual([{ map: new Map(), failed: true }]);
    expect(queue).toHaveLength(1);
    queue.shift()!();
    await settle();
    expect(results[1]).toEqual({ map: new Map([[uuid(1), 'ready']]), failed: false });
    // Ready: nothing left to recheck.
    expect(queue).toHaveLength(0);
  });

  it('stops rechecking a pending image after 20 tries', async () => {
    const { queue, schedule } = scheduler();
    let calls = 0;
    gallery.watchMediaStatus([uuid(1)], async () => { calls += 1; return new Map([[uuid(1), 'pending']]); }, () => {}, schedule);
    await settle();
    while (queue.length > 0) { queue.shift()!(); await settle(); }
    expect(calls).toBe(21);
  });

  it('reports nothing after the strip unmounts', async () => {
    const { schedule } = scheduler();
    const results: unknown[] = [];
    const stop = gallery.watchMediaStatus([uuid(1)], async () => new Map([[uuid(1), 'ready']]), (result: unknown) => results.push(result), schedule);
    stop();
    await settle();
    expect(results).toEqual([]);
  });
});

describe('worker media source', () => {
  it('asks the status route in chunks it accepts, each id once, same-origin and uncached', async () => {
    const ids = [...refs(70).map(ref => ref.id), uuid(1)];
    expect(gallery.statusChunks(ids).map((chunk: string[]) => chunk.length)).toEqual([32, 32, 6]);
    const asked: Array<{ url: string; init: RequestInit }> = [];
    const source = gallery.createWorkerMediaSource(async (url: string, init: RequestInit) => {
      asked.push({ url, init });
      const chunk = new URL(url, 'http://worker').searchParams.get('ids')!.split(',');
      return Response.json({ attachments: chunk.map(id => ({ id, state: 'ready' })) });
    });
    const states = await source.status(ids);
    expect(asked).toHaveLength(3);
    expect(asked.every(request => request.url.startsWith('/api/media/status?ids=') && request.init.credentials === 'same-origin' && request.init.cache === 'no-store')).toBe(true);
    expect(states.size).toBe(70);
  });

  it('throws when any chunk fails, so the strip shows Unavailable and rechecks', async () => {
    let call = 0;
    const source = gallery.createWorkerMediaSource(async () => (++call === 2 ? new Response('{}', { status: 503 }) : Response.json({ attachments: [] })));
    await expect(source.status(refs(40).map(ref => ref.id))).rejects.toThrow('status 503');
  });
});

describe('server-rendered gallery', () => {
  it('renders nothing for image-free rows and cards', () => {
    expect(gallery.renderStrip({ title: 'No images' })).toBe('');
    expect(gallery.renderStrip({ media: { version: 1, attachments: [] }, title: 'No images' })).toBe('');
    expect(gallery.renderBadge({})).toBe('');
  });

  it('shows four thumbnails, then "+N", with every image labelled and checking until status answers', () => {
    const html = gallery.renderStrip({ media: { version: 1, attachments: refs(6, 'uninspected') }, title: 'Fix the parser' });
    expect(html.match(/class="obs-media-thumb"/g)).toHaveLength(4);
    expect(html).toContain('>+2</button>');
    expect(html).toContain('6 images');
    expect(html).toContain('6 not inspected');
    expect(html).toContain('Open image 1 of 6 (event1_image1): Checking…');
    // No pixels before readiness is known, and never a storage or file path.
    expect(html).not.toContain('<img');
    for (const forbidden of ['/Users/', 'file://', 'http://', 'https://', 'source_pointer']) expect(html).not.toContain(forbidden);
  });

  it('a card preview counts the request’s images and sends "+N" to the drawer', () => {
    const preview = { version: 1, attachments: refs(4) };
    const card = gallery.renderStrip({ media: preview, total: 9, title: 'Card', onMore: () => {} });
    expect(card).toContain('9 images');
    expect(card).toContain('>+5</button>');
    expect(card).toContain('Open image 1 of 9');
    // A preview does not claim how many of the request's images were inspected.
    expect(gallery.renderStrip({ media: { version: 1, attachments: refs(4, 'uninspected') }, total: 9, title: 'Card', onMore: () => {} })).not.toContain('obs-media-tag');
    // Without somewhere to send it, "+N" is not offered.
    expect(gallery.renderStrip({ media: preview, total: 9, title: 'Card' })).not.toContain('>+5<');
    expect(gallery.renderBadge({ media: preview, count: 9 })).toContain('aria-label="9 images"');
    expect(gallery.renderBadge({ media: { version: 1, attachments: refs(1), overflow: true } })).toContain('1 image (more on the source event)');
  });

  it('sample mode fixtures cover every display state and render without a worker', () => {
    expect(gallery.SAMPLE_MEDIA_REFS).toHaveLength(6);
    const sample = gallery.SAMPLE_REQUESTS.find((request: any) => request.id === 'r1');
    expect(sample.media).toEqual({ count: 6, preview: gallery.SAMPLE_MEDIA_REFS.slice(0, 4) });
    expect(gallery.renderWithSample({ media: { version: 1, attachments: gallery.SAMPLE_MEDIA_REFS }, title: 'Sample' })).toContain('6 images');
  });

  it('the drawer strip holds each linked image once, newest record first', () => {
    const shared = refs(2);
    const images = gallery.requestImages({ granular: [
      { kind: 'work', text: 'a', at: '1', media: { version: 1, attachments: [shared[1], shared[0]] } },
      { kind: 'work', text: 'b', at: '2' },
      { kind: 'memory', text: 'c', at: '3', media: { version: 1, attachments: [shared[0], ...refs(3).slice(2)] } },
    ] });
    expect(images.attachments.map((ref: { id: string }) => ref.id)).toEqual([uuid(2), uuid(1), uuid(3)]);
    expect(gallery.requestImages({ granular: [{ kind: 'work', text: 'a', at: '1' }] })).toBeUndefined();
  });
});
