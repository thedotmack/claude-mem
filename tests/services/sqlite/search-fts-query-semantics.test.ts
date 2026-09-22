import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

describe('search FTS query semantics', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(sessionId: string, title: string, narrative: string): void {
    const sdkId = store.createSDKSession(sessionId, 'fts-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, `${sessionId}-mem`);
    store.storeObservation(`${sessionId}-mem`, 'fts-project', {
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

  function seedSummary(memorySessionId: string, request: string): void {
    const sdkId = store.createSDKSession(`${memorySessionId}-raw`, 'fts-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.importSessionSummary({
      memory_session_id: memorySessionId,
      project: 'fts-project',
      request,
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      created_at_epoch: 1_700_000_000_000,
    });
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    seedObservation(
      'obs-1',
      'Plugin version cleanup',
      'We fixed the orphaned plugin version left behind by the installer.',
    );
    seedObservation(
      'obs-2',
      'Plugin cleanup',
      'This mention has plugin and version but not the missing term.',
    );
    seedSummary('sum-1', 'Trace orphaned plugin version mismatch during startup');
  });

  afterEach(() => {
    store.close();
  });

  it('matches multi-word observation queries with token-level AND semantics', () => {
    const results = search.searchObservations('orphaned plugin version', { project: 'fts-project' });
    expect(results.map(result => result.title)).toEqual(['Plugin version cleanup']);
  });

  it('matches multi-word observation queries without requiring an exact phrase', () => {
    const results = search.searchObservations('plugin orphaned version', { project: 'fts-project' });
    expect(results.map(result => result.title)).toEqual(['Plugin version cleanup']);
  });

  it('matches multi-word session summary queries with token-level AND semantics', () => {
    const results = search.searchSessions('orphaned plugin version', { project: 'fts-project' });
    expect(results.map(result => result.request)).toEqual(['Trace orphaned plugin version mismatch during startup']);
  });
});
