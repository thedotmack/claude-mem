import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextCacheKeys, readContextCache } from '../../src/shared/context-cache.js';
import { emitContextInvalidation } from '../../src/shared/context-invalidation.js';
import { ContextCacheService, type ContextVariantRender } from '../../src/services/worker/ContextCacheService.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('cached context read scope belongs to the accepted body', () => {
  const keys = contextCacheKeys(['scope-order-project'], 'claude', false);
  const currentScope = [...keys.projects, 'adopted-current'];
  const previousScope = [...keys.projects, 'adopted-before-merge'];
  let directory: string;
  let previousDataDir: string | undefined;
  let service: ContextCacheService;
  let expand: () => string[] | Promise<string[]>;
  let render: () => Promise<ContextVariantRender>;
  let renders: number;
  const body = () => readContextCache(keys, Date.now())?.body ?? null;
  const saveCurrent = () => service.recordLiveRender(keys,
    { body: 'CURRENT BODY', cacheable: true, readKeys: currentScope }, Date.now(),
    service.removalGenerationNow(), service.beginRenderSequence());
  const removeCurrent = () => emitContextInvalidation({ projects: ['ADOPTED-CURRENT'] }, 'deleteObservation', 'removal');

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'context-read-scope-'));
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = directory;
    expand = () => keys.projects;
    renders = 0;
    render = async () => ({ body: 'REFRESHED BODY', cacheable: true, readKeys: currentScope });
    service = new ContextCacheService({
      debounceMs: 60_000,
      expandProjectReadKeys: () => expand(),
      renderVariant: () => { renders++; return render(); },
    });
    service.start();
    await saveCurrent();
  });

  afterEach(() => {
    service.stop();
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  for (const cacheable of [true, false]) {
    it(`a discarded ${cacheable ? 'cacheable' : 'uncacheable'} live result cannot replace the persisted body's scope`, async () => {
      const staleSequence = service.beginRenderSequence();
      await saveCurrent();
      await service.recordLiveRender(keys, { body: 'OLD BODY', cacheable, readKeys: previousScope }, Date.now(),
        service.removalGenerationNow(), staleSequence);
      expect(body()).toBe('CURRENT BODY');

      removeCurrent();
      expect(body()).toBeNull();
      await service.flushPendingRenders();
      expect(body()).toBe('REFRESHED BODY');
      expect(renders).toBe(1);
    });
  }

  it('a discarded live result cannot prevent an additive write from refreshing the current body', async () => {
    const staleSequence = service.beginRenderSequence();
    await saveCurrent();
    await service.recordLiveRender(keys, { body: 'OLD BODY', cacheable: true, readKeys: previousScope }, Date.now(),
      service.removalGenerationNow(), staleSequence);
    emitContextInvalidation({ projects: ['adopted-current'] }, 'storeObservation');
    expect(body()).toBe('CURRENT BODY');
    await service.flushPendingRenders();
    expect(body()).toBe('REFRESHED BODY');
    expect(renders).toBe(1);
  });

  it('a live result overtaken by a removal cannot change the newer body scope', async () => {
    const oldGeneration = service.removalGenerationNow();
    const oldSequence = service.beginRenderSequence();
    emitContextInvalidation('all', 'merge-projects', 'removal');
    await saveCurrent();
    await service.recordLiveRender(keys, { body: 'BEFORE MERGE', cacheable: true, readKeys: previousScope }, Date.now(),
      oldGeneration, oldSequence);
    expect(body()).toBe('CURRENT BODY');
    removeCurrent();
    expect(body()).toBeNull();
  });

  it('a late asynchronous live scope lookup cannot replace a newer accepted scope', async () => {
    const pending = deferred<string[]>();
    expand = () => pending.promise;
    const old = service.recordLiveRender(keys, { body: 'OLD BODY', cacheable: true }, Date.now(),
      service.removalGenerationNow(), service.beginRenderSequence());
    await saveCurrent();
    pending.resolve(previousScope);
    await old;
    expect(body()).toBe('CURRENT BODY');
    removeCurrent();
    expect(body()).toBeNull();
  });

  for (const asynchronous of [false, true]) {
    it(`a ${asynchronous ? 'pending' : 'synchronous'} fallback scope rejected by an unrelated removal cannot change the cached body scope`, async () => {
      const oldGeneration = service.removalGenerationNow();
      const oldSequence = service.beginRenderSequence();
      const pending = deferred<string[]>();
      expand = () => asynchronous ? pending.promise : previousScope;
      emitContextInvalidation({ projects: ['unrelated-project'] }, 'deleteObservation', 'removal');
      expect(body()).toBe('CURRENT BODY');
      const old = service.recordLiveRender(keys, { body: 'REJECTED BODY', cacheable: true }, Date.now(),
        oldGeneration, oldSequence);
      pending.resolve(previousScope);
      await old;
      expect(body()).toBe('CURRENT BODY');
      removeCurrent();
      expect(body()).toBeNull();
    });
  }

  it('a queued scope lookup overtaken by a live render leaves that body scope intact', async () => {
    const pending = deferred<string[]>();
    const entered = deferred<void>();
    expand = () => { entered.resolve(); return pending.promise; };
    render = async () => ({ body: 'OLD QUEUED BODY', cacheable: true });
    emitContextInvalidation('all', 'storeObservation');
    const flushing = service.flushPendingRenders();
    await entered.promise;
    await saveCurrent();
    pending.resolve(previousScope);
    await flushing;
    expect(body()).toBe('CURRENT BODY');
    removeCurrent();
    expect(body()).toBeNull();
  });

  it('a queued render retains the scope it actually rendered instead of the earlier lookup', async () => {
    expand = () => previousScope;
    emitContextInvalidation('all', 'storeObservation');
    await service.flushPendingRenders();
    expect(body()).toBe('REFRESHED BODY');
    removeCurrent();
    expect(body()).toBeNull();
  });

  it('warming a different session response does not replace a fresh body read scope', async () => {
    await service.warmVariant(keys, previousScope);
    expect(body()).toBe('CURRENT BODY');
    expect(renders).toBe(0);
    removeCurrent();
    expect(body()).toBeNull();
  });

  it('an accepted live render replaces its old scope and still includes the requested project', async () => {
    await service.recordLiveRender(keys, { body: 'NEW SCOPE', cacheable: true, readKeys: ['new-alias'] }, Date.now(),
      service.removalGenerationNow(), service.beginRenderSequence());
    removeCurrent();
    expect(body()).toBe('NEW SCOPE');
    emitContextInvalidation({ projects: keys.projects }, 'deleteObservation', 'removal');
    expect(body()).toBeNull();
  });

  it('a queued render without returned scope still uses its expanded keys', async () => {
    expand = () => currentScope;
    render = async () => ({ body: 'LEGACY RENDER', cacheable: true });
    emitContextInvalidation('all', 'storeObservation');
    await service.flushPendingRenders();
    expect(body()).toBe('LEGACY RENDER');
    removeCurrent();
    expect(body()).toBeNull();
  });

  it('still queues a later render when an additive write touches an in-flight expanded scope', async () => {
    const entered = deferred<void>();
    const pending = deferred<ContextVariantRender>();
    const nextScope = [...keys.projects, 'newly-adopted-project'];
    expand = () => nextScope;
    render = async () => {
      if (renders === 1) { entered.resolve(); return pending.promise; }
      return { body: 'AFTER ADDITIVE WRITE', cacheable: true, readKeys: nextScope };
    };
    emitContextInvalidation('all', 'storeObservation');
    const flushing = service.flushPendingRenders();
    await entered.promise;
    emitContextInvalidation({ projects: ['NEWLY-ADOPTED-PROJECT'] }, 'storeObservation');
    pending.resolve({ body: 'BEFORE ADDITIVE WRITE', cacheable: true, readKeys: nextScope });
    await flushing;
    await service.flushPendingRenders();
    expect(renders).toBe(2);
    expect(body()).toBe('AFTER ADDITIVE WRITE');
  });
});
