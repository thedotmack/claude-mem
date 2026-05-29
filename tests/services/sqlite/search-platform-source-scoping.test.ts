import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// Read-side source-scoping (#2389): /api/search must honor platformSource so a
// codex (or other-agent) search returns only codex-sourced rows and never
// bleeds cross-platform / null-source memories.
describe('search platform_source scoping', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(
    contentSessionId: string,
    memorySessionId: string,
    platformSource: string,
    title: string,
    narrative: string,
  ): void {
    const sdkId = store.createSDKSession(contentSessionId, 'scoping-project', 'prompt', undefined, platformSource);
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.storeObservation(memorySessionId, 'scoping-project', {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    seedObservation('codex-sess', 'codex-mem', 'codex', 'Codex finding', 'shared scoping keyword from codex');
    seedObservation('claude-sess', 'claude-mem', 'claude', 'Claude finding', 'shared scoping keyword from claude');
  });

  afterEach(() => {
    store.close();
  });

  it('returns only codex-sourced rows when platformSource=codex', () => {
    const results = search.searchObservations('scoping', { platformSource: 'codex', project: 'scoping-project' });
    expect(results.length).toBe(1);
    expect(results[0].memory_session_id).toBe('codex-mem');
    expect(results[0].title).toBe('Codex finding');
  });

  it('returns only claude-sourced rows when platformSource=claude (no null-source bleed)', () => {
    const results = search.searchObservations('scoping', { platformSource: 'claude', project: 'scoping-project' });
    expect(results.length).toBe(1);
    expect(results[0].memory_session_id).toBe('claude-mem');
  });

  it('returns all sources when platformSource is omitted', () => {
    const results = search.searchObservations('scoping', { project: 'scoping-project' });
    expect(results.length).toBe(2);
  });

  it('applies the filter on the no-query (filter-only) path too', () => {
    const results = search.searchObservations(undefined, { platformSource: 'codex', project: 'scoping-project' });
    expect(results.length).toBe(1);
    expect(results[0].memory_session_id).toBe('codex-mem');
  });
});
