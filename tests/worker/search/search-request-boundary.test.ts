import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';
import { AppError } from '../../../src/services/server/ErrorHandler.js';

// Each SessionSearch leg returns [] when none of the filters apply to it, so a filter-only
// search like obs_type-only no longer 400s on the sessions/prompts legs. The request as a
// whole still needs a query or at least one filter: that check lives at the request boundary.
describe('search request boundary', () => {
  let db: Database;
  let store: SessionStore;
  let manager: SearchManager;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    const search = new SessionSearch(db);
    manager = new SearchManager(search, store, null, new FormattingService(), new TimelineService());

    const sdkId = store.createSDKSession('boundary-content', 'boundary-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, 'boundary-mem');
    store.storeObservation('boundary-mem', 'boundary-project', {
      type: 'bugfix',
      title: 'Fixed the flaky boundary',
      subtitle: null,
      facts: [],
      narrative: 'a bugfix narrative',
      concepts: ['gotcha'],
      files_read: [],
      files_modified: [],
    }, 1);
  });

  afterEach(() => {
    db.close();
  });

  async function expectInvalidSearchRequest(run: () => Promise<unknown>): Promise<void> {
    const error = await run().then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(400);
    expect((error as AppError).code).toBe('INVALID_SEARCH_REQUEST');
  }

  it('returns observations for an obs_type-only search with no project', async () => {
    const result = await manager.search({ obs_type: 'bugfix', format: 'json' });
    expect(result.observations.map((o: { title: string }) => o.title)).toEqual(['Fixed the flaky boundary']);
    expect(result.sessions).toEqual([]);
    expect(result.prompts).toEqual([]);
  });

  it('returns observations for a concepts-only search with no project', async () => {
    const result = await manager.search({ concepts: 'gotcha', format: 'json' });
    expect(result.observations.map((o: { title: string }) => o.title)).toEqual(['Fixed the flaky boundary']);
  });

  it('rejects a search with no query and no filter with a 400', async () => {
    await expectInvalidSearchRequest(() => manager.search({ format: 'json' }));
  });

  it('treats a category-only type as no filter', async () => {
    await expectInvalidSearchRequest(() => manager.search({ type: 'observations', format: 'json' }));
  });

  it('rejects an orchestrator search with no query and no filter with a 400', async () => {
    await expectInvalidSearchRequest(() => manager.getOrchestrator().search({ limit: 5 }));
  });

  it('returns rows from an orchestrator search filtered only by obs_type', async () => {
    const result = await manager.getOrchestrator().search({ obs_type: 'bugfix' });
    expect(result.results.observations.map(o => o.title)).toEqual(['Fixed the flaky boundary']);
  });

  it('refuses to build a corpus from an empty filter instead of writing an empty corpus', async () => {
    const writes: unknown[] = [];
    const builder = new CorpusBuilder(store, manager.getOrchestrator(), { write: (corpus: unknown) => writes.push(corpus) } as any);

    await expectInvalidSearchRequest(() => builder.build('everything', '', {}));
    expect(writes).toEqual([]);
  });
});
