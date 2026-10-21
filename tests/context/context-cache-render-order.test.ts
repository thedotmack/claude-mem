/**
 * Precomputed SessionStart context: render results are ordered by when a render
 * STARTED, not when it finished.
 *
 * Two renders can be in flight for one variant at once — the live route renders
 * on a SessionStart request, and the debounced queue re-renders after a write.
 * Whichever finishes last used to win the file, so a render that began before a
 * write could overwrite the queued render that had already read that write. The
 * cache then served pre-write content with nothing pending, until the next
 * write or the 24h expiry. A per-variant start sequence keeps the newer render.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  contextCacheKeys,
  readContextCache,
} from '../../src/shared/context-cache.js';
import { emitContextInvalidation } from '../../src/shared/context-invalidation.js';
import {
  ContextCacheService,
  type ContextVariantRender,
} from '../../src/services/worker/ContextCacheService.js';

describe('ContextCacheService render ordering', () => {
  const DEBOUNCE_MS = 20;
  const project = 'render-order-proj';
  const keys = contextCacheKeys([project], 'claude', false);

  let service: ContextCacheService;
  let tempDir: string;
  let previousDataDir: string | undefined;
  let queuedRenderCount: number;
  /** When set, each queued render waits on it (an in-flight render others can overtake). */
  let renderGate: Promise<void> | null;

  const waitPastDebounce = async () => {
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 4));
    await service.flushPendingRenders();
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-render-order-'));
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    queuedRenderCount = 0;
    renderGate = null;
    service = new ContextCacheService({
      debounceMs: DEBOUNCE_MS,
      renderVariant: async (): Promise<ContextVariantRender> => {
        if (renderGate) await renderGate;
        queuedRenderCount++;
        return { body: `queued render #${queuedRenderCount}`, cacheable: true };
      },
      expandProjectReadKeys: projects => projects,
    });
    service.start();
    service.recordLiveRender(keys, { body: 'first live render', cacheable: true }, Date.now(), undefined, service.beginRenderSequence());
    await service.flushPendingRenders();
  });

  afterEach(() => {
    service.stop();
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a live render does not overwrite a queued render that started after it', async () => {
    // The live route takes its ticket before it renders.
    const liveSequence = service.beginRenderSequence();

    // A write lands while that render is in flight; its queued re-render reads
    // the write and finishes first.
    emitContextInvalidation('all', 'store-observation', 'write');
    await waitPastDebounce();
    const queuedBody = readContextCache(keys, Date.now())?.body;
    expect(queuedBody).toBe('queued render #1');

    // The live render now completes, carrying the body it read before the write.
    service.recordLiveRender(
      keys,
      { body: 'live body rendered before the write', cacheable: true },
      Date.now(),
      undefined,
      liveSequence,
    );

    expect(readContextCache(keys, Date.now())?.body).toBe(queuedBody);
  });

  it('a queued render does not overwrite a live render that started after it', async () => {
    let releaseGate = () => {};
    renderGate = new Promise<void>(resolve => { releaseGate = resolve; });

    // A write queues a re-render, which starts and then blocks on the gate.
    emitContextInvalidation('all', 'store-observation', 'write');
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 4));

    // A SessionStart request renders after that queued render began, so it sees
    // at least as much as the queued one, and it records first.
    const liveSequence = service.beginRenderSequence();
    service.recordLiveRender(
      keys,
      { body: 'newer live render', cacheable: true },
      Date.now(),
      undefined,
      liveSequence,
    );
    expect(readContextCache(keys, Date.now())?.body).toBe('newer live render');

    // The queued render finishes last; its older body must not land.
    renderGate = null;
    releaseGate();
    await service.flushPendingRenders();

    expect(readContextCache(keys, Date.now())?.body).toBe('newer live render');
  });

  it('a later render still replaces the file', async () => {
    emitContextInvalidation('all', 'store-observation', 'write');
    await waitPastDebounce();
    expect(readContextCache(keys, Date.now())?.body).toBe('queued render #1');

    // A live render that started after that queued render is the newest body.
    service.recordLiveRender(
      keys,
      { body: 'newest live render', cacheable: true },
      Date.now(),
      undefined,
      service.beginRenderSequence(),
    );
    expect(readContextCache(keys, Date.now())?.body).toBe('newest live render');

    // And a write after that still re-renders normally.
    emitContextInvalidation('all', 'store-observation', 'write');
    await waitPastDebounce();
    expect(readContextCache(keys, Date.now())?.body).toBe('queued render #2');
  });
});
