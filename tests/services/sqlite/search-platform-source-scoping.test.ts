import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

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

  function seedPrompt(
    contentSessionId: string,
    platformSource: string,
    promptText: string,
  ): void {
    const sdkId = store.createSDKSession(contentSessionId, 'scoping-project', 'prompt', undefined, platformSource);
    store.saveUserPrompt(contentSessionId, 1, promptText, sdkId);
  }

  function seedSummary(memorySessionId: string, request: string, createdAtEpoch: number): number {
    return store.importSessionSummary({
      memory_session_id: memorySessionId,
      project: 'scoping-project',
      request,
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: JSON.stringify(['src/shared.ts']),
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(createdAtEpoch).toISOString(),
      created_at_epoch: createdAtEpoch,
    }).id;
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);

    seedObservation('codex-sess', 'codex-mem', 'codex', 'Codex finding', 'shared scoping keyword from codex');
    seedObservation('claude-sess', 'claude-mem', 'claude', 'Claude finding', 'shared scoping keyword from claude');
    seedPrompt('shared-prompt-raw-id', 'codex', 'overlap prompt from codex');
    seedPrompt('shared-prompt-raw-id', 'claude', 'overlap prompt from claude');
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

  it('applies platformSource to prompt search when raw content ids overlap', () => {
    const results = search.searchUserPrompts('overlap', { platformSource: 'codex', project: 'scoping-project' });
    expect(results.length).toBe(1);
    expect(results[0].prompt_text).toBe('overlap prompt from codex');
    expect(results[0].platform_source).toBe('codex');
  });

  it('applies platformSource to observation ID hydration', () => {
    const allResults = search.searchObservations(undefined, { project: 'scoping-project' });
    const results = store.getObservationsByIds(
      allResults.map(result => result.id),
      { orderBy: 'relevance', platformSource: 'codex', project: 'scoping-project' },
    );

    expect(results.length).toBe(1);
    expect(results[0].memory_session_id).toBe('codex-mem');
  });

  it('applies platformSource to summary ID hydration', () => {
    const codexSummaryId = seedSummary('codex-mem', 'codex file summary', 1_700_000_000_000);
    const claudeSummaryId = seedSummary('claude-mem', 'claude file summary', 1_700_000_001_000);

    const results = store.getSessionSummariesByIds(
      [claudeSummaryId, codexSummaryId],
      { orderBy: 'relevance', platformSource: 'codex', project: 'scoping-project' },
    );

    expect(results.map(result => result.id)).toEqual([codexSummaryId]);
    expect(results[0].memory_session_id).toBe('codex-mem');
  });

  it('applies platformSource to by-file session summary matches', () => {
    seedSummary('codex-mem', 'codex file summary', 1_700_000_000_000);
    seedSummary('claude-mem', 'claude file summary', 1_700_000_001_000);

    const results = search.findByFile('src/shared.ts', {
      platformSource: 'codex',
      project: 'scoping-project',
    });

    expect(results.sessions.length).toBe(1);
    expect(results.sessions[0].memory_session_id).toBe('codex-mem');
    expect(results.sessions[0].request).toBe('codex file summary');
  });

  it('writes platform_source metadata for Chroma prompt docs', () => {
    const sync = new ChromaSync('scoping-project');
    const doc = (sync as any).formatUserPromptDoc({
      id: 123,
      content_session_id: 'shared-prompt-raw-id',
      prompt_number: 1,
      prompt_text: 'overlap prompt from codex',
      created_at_epoch: Date.now(),
      memory_session_id: 'codex-mem',
      project: 'scoping-project',
      platform_source: 'codex',
    });

    expect(doc.metadata.platform_source).toBe('codex');
  });

  it('writes platform_source metadata for Chroma observation docs', () => {
    const sync = new ChromaSync('scoping-project');
    const docs = (sync as any).formatObservationDocs({
      id: 124,
      memory_session_id: 'codex-mem',
      project: 'scoping-project',
      merged_into_project: null,
      platform_source: 'codex',
      text: null,
      type: 'discovery',
      title: 'Codex observation',
      subtitle: null,
      facts: JSON.stringify(['fact']),
      narrative: 'codex narrative',
      concepts: JSON.stringify([]),
      files_read: JSON.stringify([]),
      files_modified: JSON.stringify([]),
      prompt_number: 1,
      created_at_epoch: Date.now(),
    });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((doc: any) => doc.metadata.platform_source === 'codex')).toBe(true);
  });

  it('writes platform_source metadata for Chroma summary docs', () => {
    const sync = new ChromaSync('scoping-project');
    const docs = (sync as any).formatSummaryDocs({
      id: 125,
      memory_session_id: 'codex-mem',
      project: 'scoping-project',
      merged_into_project: null,
      platform_source: 'codex',
      request: 'codex summary request',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      notes: null,
      prompt_number: 1,
      created_at_epoch: Date.now(),
    });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((doc: any) => doc.metadata.platform_source === 'codex')).toBe(true);
  });
});
