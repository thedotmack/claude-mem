/**
 * Precomputed SessionStart context: render results are ordered by when a render
 * STARTED, not when it finished.
 *
 * Two renders can be in flight for one variant at once — the live route renders
 * on a SessionStart request, and the debounced queue re-renders after a write.
 * Whichever finished last used to win the file. A live render that began before
 * a write could overwrite the queued render that had already read that write.
 * Since #4830 the live route passes invalidationGenerationAtStart, so the cache
 * re-queued and healed one debounce later, but it served the pre-write body
 * until then and paid for a redundant re-render. A queued render that failed
 * after a newer live render had written could also delete that good file.
 * A per-variant start sequence keeps the newer render's result in every case.
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
  /** Resolved when a queued render has taken its ticket and reached the gate. */
  let signalQueuedRenderEntered: () => void;
  let queuedRenderEntered: Promise<void>;
  /** When set, the next queued render throws after the gate instead of returning. */
  let failNextQueuedRender: boolean;

  const waitPastDebounce = async () => {
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 4));
    await service.flushPendingRenders();
  };

  /** Queue a re-render with a write and wait until it is in flight, blocked on the gate. */
  const startBlockedQueuedRender = async (): Promise<() => void> => {
    let releaseGate = () => {};
    renderGate = new Promise<void>(resolve => { releaseGate = resolve; });
    queuedRenderEntered = new Promise<void>(resolve => { signalQueuedRenderEntered = resolve; });
    emitContextInvalidation('all', 'store-observation', 'write');
    await queuedRenderEntered;
    return () => {
      renderGate = null;
      releaseGate();
    };
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-render-order-'));
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    queuedRenderCount = 0;
    renderGate = null;
    failNextQueuedRender = false;
    signalQueuedRenderEntered = () => {};
    service = new ContextCacheService({
      debounceMs: DEBOUNCE_MS,
      renderVariant: async (): Promise<ContextVariantRender> => {
        signalQueuedRenderEntered();
        if (renderGate) await renderGate;
        if (failNextQueuedRender) {
          failNextQueuedRender = false;
          throw new Error('queued render failed');
        }
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

  it('a live render carrying invalidationGenerationAtStart is dropped without a redundant re-render', async () => {
    // What the live SessionStart route does: read both generations, then take a ticket.
    const removalGenerationAtRenderStart = service.removalGenerationNow();
    const invalidationGenerationAtStart = service.invalidationGenerationNow();
    const liveSequence = service.beginRenderSequence();

    emitContextInvalidation('all', 'store-observation', 'write');
    await waitPastDebounce();
    expect(readContextCache(keys, Date.now())?.body).toBe('queued render #1');

    await service.recordLiveRender(
      keys,
      { body: 'live body rendered before the write', cacheable: true, invalidationGenerationAtStart },
      Date.now(),
      removalGenerationAtRenderStart,
      liveSequence,
    );

    // The stale body never reaches the file, not even for one debounce interval.
    expect(readContextCache(keys, Date.now())?.body).toBe('queued render #1');
    // The queued render that overtook it already read the write, so no heal is queued.
    await waitPastDebounce();
    expect(queuedRenderCount).toBe(1);
    expect(readContextCache(keys, Date.now())?.body).toBe('queued render #1');
  });

  it('a queued render does not overwrite a live render that started after it', async () => {
    // A write queues a re-render, which takes its ticket and then blocks on the gate.
    const releaseQueuedRender = await startBlockedQueuedRender();

    // A SessionStart request renders after that queued render began, so it sees
    // at least as much as the queued one, and it records first.
    await service.recordLiveRender(
      keys,
      { body: 'newer live render', cacheable: true },
      Date.now(),
      undefined,
      service.beginRenderSequence(),
    );
    expect(readContextCache(keys, Date.now())?.body).toBe('newer live render');

    // The queued render finishes last; its older body must not land.
    releaseQueuedRender();
    await service.flushPendingRenders();

    expect(readContextCache(keys, Date.now())?.body).toBe('newer live render');
  });

  it('a queued render that fails does not remove a live render that started after it', async () => {
    failNextQueuedRender = true;
    const releaseQueuedRender = await startBlockedQueuedRender();

    await service.recordLiveRender(
      keys,
      { body: 'newer live render', cacheable: true },
      Date.now(),
      undefined,
      service.beginRenderSequence(),
    );
    expect(readContextCache(keys, Date.now())?.body).toBe('newer live render');

    // The queued render rejects; the newer live file is still correct, so it stays.
    releaseQueuedRender();
    await service.flushPendingRenders();

    expect(readContextCache(keys, Date.now())?.body).toBe('newer live render');
  });

  it('a queued render that fails with nothing newer on disk still removes the file', async () => {
    failNextQueuedRender = true;
    emitContextInvalidation('all', 'store-observation', 'write');
    await waitPastDebounce();

    // The pre-write file would now be wrong; the hook must take the live path.
    expect(readContextCache(keys, Date.now())).toBeNull();
  });

  it('a later render still replaces the file', async () => {
    emitContextInvalidation('all', 'store-observation', 'write');
    await waitPastDebounce();
    expect(readContextCache(keys, Date.now())?.body).toBe('queued render #1');

    // A live render that started after that queued render is the newest body.
    await service.recordLiveRender(
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
