import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';

describe('SearchManager platform-scoped Chroma hydration', () => {
  it('normalizes date_from/date_to filters into dateRange for worker search', async () => {
    const searchObservations = mock(() => []);
    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
      {} as any,
      {} as any,
    );

    await manager.search({
      type: 'observations',
      date_from: '2025-01-01',
      date_to: '2025-01-31',
      format: 'json',
    });

    expect(searchObservations).toHaveBeenCalledWith(undefined, expect.objectContaining({
      dateRange: {
        start: '2025-01-01',
        end: '2025-01-31',
      },
    }));
  });

  it('passes platformSource into Chroma observation where filter and SQLite hydration', async () => {
    const observation = {
      id: 5,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'cursor overlap observation',
      subtitle: null,
      facts: '[]',
      narrative: 'cursor overlap narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const getObservationsByIds = mock(() => [observation]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [observation.id],
      distances: [0.1],
      metadatas: [{
        sqlite_id: observation.id,
        doc_type: 'observation',
        project: 'search-project',
        platform_source: 'cursor',
        created_at_epoch: Date.now(),
      }],
    }));

    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds,
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'overlap',
      type: 'observations',
      project: 'search-project',
      platformSource: 'cursor',
      format: 'json',
      limit: 10,
    });

    expect(queryChroma).toHaveBeenCalledWith('overlap', 100, {
      $and: [
        { doc_type: 'observation' },
        { $or: [{ project: 'search-project' }, { merged_into_project: 'search-project' }] },
        { platform_source: 'cursor' },
      ],
    });
    expect(getObservationsByIds).toHaveBeenCalledWith([observation.id], expect.objectContaining({
      platformSource: 'cursor',
      project: 'search-project',
    }));
    expect(result.observations).toEqual([observation]);
  });

  it('renders date_desc search results newest day first', async () => {
    const jan4 = {
      id: 4,
      memory_session_id: 'session-4',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'Older observation',
      subtitle: null,
      facts: '[]',
      narrative: 'older',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: '2025-01-04T10:00:00.000Z',
      created_at_epoch: Date.parse('2025-01-04T10:00:00.000Z'),
    };
    const jan6 = {
      ...jan4,
      id: 6,
      title: 'Newer observation',
      created_at: '2025-01-06T10:00:00.000Z',
      created_at_epoch: Date.parse('2025-01-06T10:00:00.000Z'),
    };

    const manager = new SearchManager(
      {
        searchObservations: mock(() => [jan4, jan6]),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      { getProjectReadKeys: (projects: string[]) => projects } as any,
      null,
      {
        formatSearchTableHeader: mock(() => '| h |'),
        formatObservationSearchRow: mock((obs: any) => ({ row: obs.title, time: '' })),
      } as any,
      {} as any,
    );

    const result = await manager.search({
      project: 'search-project',
      orderBy: 'date_desc',
      format: 'text',
      limit: 5,
    });

    const text = result.content[0].text as string;
    expect(text.indexOf('### Jan 6')).toBeLessThan(text.indexOf('### Jan 4'));
  });

  it('keeps Chroma at its candidate batch, hydrates in the requested date order, and adds FTS matches selected by date', async () => {
    const getObservationsByIds = mock(() => []);
    const getSessionSummariesByIds = mock(() => []);
    const getUserPromptsByIds = mock(() => []);
    const searchObservations = mock(() => []);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    const queryChroma = mock(() => Promise.resolve({
      ids: [11, 22, 33],
      distances: [0.1, 0.2, 0.3],
      metadatas: [
        { sqlite_id: 11, doc_type: 'observation', created_at_epoch: Date.now() },
        { sqlite_id: 22, doc_type: 'session_summary', created_at_epoch: Date.now() },
        { sqlite_id: 33, doc_type: 'user_prompt', created_at_epoch: Date.now() },
      ],
    }));

    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions,
        searchUserPrompts,
      } as any,
      {
        getObservationsByIds,
        getSessionSummariesByIds,
        getUserPromptsByIds,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    await manager.search({
      query: 'trading',
      orderBy: 'date_asc',
      format: 'json',
      limit: 5,
    });

    expect(queryChroma).toHaveBeenCalledWith('trading', 100, undefined);
    expect(getObservationsByIds).toHaveBeenCalledWith([11], expect.objectContaining({ orderBy: 'date_asc' }));
    expect(getSessionSummariesByIds).toHaveBeenCalledWith([22], expect.objectContaining({ orderBy: 'date_asc' }));
    expect(getUserPromptsByIds).toHaveBeenCalledWith([33], expect.objectContaining({ orderBy: 'date_asc' }));
    expect(searchObservations).toHaveBeenCalledWith('trading', expect.objectContaining({ orderBy: 'date_asc', limit: 5 }));
    expect(searchSessions).toHaveBeenCalledWith('trading', expect.objectContaining({ orderBy: 'date_asc', limit: 5 }));
    expect(searchUserPrompts).toHaveBeenCalledWith('trading', expect.objectContaining({ orderBy: 'date_asc', limit: 5 }));
  });

  // #4135: Chroma picks its candidates by relevance, so the newest match can sit outside them.
  it('returns and renders first the newest keyword match that is outside the Chroma candidates (date_desc)', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const makeRow = (id: number, title: string, epoch: number) => ({
      id,
      memory_session_id: `session-${id}`,
      project: 'search-project',
      text: null,
      type: 'discovery',
      title,
      subtitle: null,
      facts: '[]',
      narrative: title,
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(epoch).toISOString(),
      created_at_epoch: epoch,
    });
    const olderChromaCandidate = makeRow(11, 'Older semantic match', Date.now() - 10 * dayMs);
    const newestKeywordMatch = makeRow(99, 'Newest keyword match', Date.now() - dayMs);
    const queryChroma = mock(() => Promise.resolve({
      ids: [olderChromaCandidate.id],
      distances: [0.1],
      metadatas: [{ sqlite_id: olderChromaCandidate.id, doc_type: 'observation', created_at_epoch: olderChromaCandidate.created_at_epoch }],
    }));

    const manager = new SearchManager(
      {
        searchObservations: mock(() => [newestKeywordMatch]),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => [olderChromaCandidate]),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
      {
        formatSearchTableHeader: mock(() => '| h |'),
        formatObservationSearchRow: mock((obs: any) => ({ row: obs.title, time: '' })),
      } as any,
      {} as any,
    );

    const newestOnly = await manager.search({ query: 'trading', type: 'observations', orderBy: 'date_desc', format: 'json', limit: 1 });
    expect(newestOnly.observations.map((o: { id: number }) => o.id)).toEqual([newestKeywordMatch.id]);

    const rendered = await manager.search({ query: 'trading', type: 'observations', orderBy: 'date_desc', format: 'text', limit: 2 });
    const text = rendered.content[0].text as string;
    expect(text.indexOf('Newest keyword match')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Newest keyword match')).toBeLessThan(text.indexOf('Older semantic match'));
  });

  it('renders relevance-ordered unified results with the most relevant day first, not oldest first', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const makeRow = (id: number, title: string, epoch: number) => ({
      id,
      memory_session_id: `session-${id}`,
      project: 'search-project',
      text: null,
      type: 'discovery',
      title,
      subtitle: null,
      facts: '[]',
      narrative: title,
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(epoch).toISOString(),
      created_at_epoch: epoch,
    });
    const mostRelevantNewer = makeRow(1, 'Most relevant match', Date.now() - dayMs);
    const lessRelevantOlder = makeRow(2, 'Less relevant match', Date.now() - 10 * dayMs);
    const queryChroma = mock(() => Promise.resolve({
      ids: [1, 2],
      distances: [0.1, 0.4],
      metadatas: [
        { sqlite_id: 1, doc_type: 'observation', created_at_epoch: mostRelevantNewer.created_at_epoch },
        { sqlite_id: 2, doc_type: 'observation', created_at_epoch: lessRelevantOlder.created_at_epoch },
      ],
    }));

    const manager = new SearchManager(
      { searchObservations: mock(() => []), searchSessions: mock(() => []), searchUserPrompts: mock(() => []) } as any,
      {
        getObservationsByIds: mock(() => [lessRelevantOlder, mostRelevantNewer]),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
      {
        formatSearchTableHeader: mock(() => '| h |'),
        formatObservationSearchRow: mock((obs: any) => ({ row: obs.title, time: '' })),
      } as any,
      {} as any,
    );

    const rendered = await manager.search({ query: 'trading', type: 'observations', format: 'text', limit: 5 });
    const text = rendered.content[0].text as string;
    expect(text.indexOf('Most relevant match')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Most relevant match')).toBeLessThan(text.indexOf('Less relevant match'));
  });

  it('hydrates Chroma observation matches in relevance order, not by date', async () => {
    // Chroma returns up to 100 candidates already ranked by distance. Hydrating
    // them with orderBy 'date_desc' discards that ranking and yields the N
    // newest candidates instead of the N most relevant, so an older exact match
    // loses to a newer vague one. 'relevance' preserves the caller-provided id
    // order (tests/services/sqlite/get-observations-by-ids-relevance.test.ts).
    // performChromaSemanticSearch already does this; these two paths did not.
    const olderExactMatch = 11;
    const newerVagueMatch = 22;
    const now = Date.now();

    const makeManager = (getObservationsByIds: any) => new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds,
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      {
        queryChroma: mock(() => Promise.resolve({
          // Chroma's own order: the exact match ranks first despite being older.
          ids: [olderExactMatch, newerVagueMatch],
          distances: [0.05, 0.4],
          metadatas: [
            { sqlite_id: olderExactMatch, doc_type: 'observation', created_at_epoch: now - 86_400_000 },
            { sqlite_id: newerVagueMatch, doc_type: 'observation', created_at_epoch: now },
          ],
        })),
      } as any,
      {} as any,
      {} as any,
    );

    const searchHydrate = mock(() => []);
    await makeManager(searchHydrate).searchObservations({ query: 'exact phrase', limit: 1 });
    expect(searchHydrate).toHaveBeenCalledWith(
      [olderExactMatch, newerVagueMatch],
      expect.objectContaining({ orderBy: 'relevance' })
    );

    const timelineHydrate = mock(() => []);
    await makeManager(timelineHydrate).getTimelineByQuery({ query: 'exact phrase', limit: 1 });
    expect(timelineHydrate).toHaveBeenCalledWith(
      [olderExactMatch, newerVagueMatch],
      expect.objectContaining({ orderBy: 'relevance' })
    );

    // timeline() picks a single anchor via searchChromaForTimeline; the anchor
    // should be the top-ranked match, not merely the most recent one.
    const anchorHydrate = mock(() => []);
    await makeManager(anchorHydrate).timeline({ query: 'exact phrase' });
    expect(anchorHydrate).toHaveBeenCalledWith(
      [olderExactMatch, newerVagueMatch],
      expect.objectContaining({ orderBy: 'relevance' })
    );
  });

  it('passes platformSource into Chroma session where filter and SQLite hydration', async () => {
    const session = {
      id: 6,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      request: 'cursor overlap session',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const getSessionSummariesByIds = mock(() => [session]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [session.id],
      distances: [0.1],
      metadatas: [{
        sqlite_id: session.id,
        doc_type: 'session_summary',
        project: 'search-project',
        platform_source: 'cursor',
        created_at_epoch: Date.now(),
      }],
    }));

    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds,
        getUserPromptsByIds: mock(() => []),         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'overlap',
      type: 'sessions',
      project: 'search-project',
      platformSource: 'cursor',
      format: 'json',
      limit: 10,
    });

    expect(queryChroma).toHaveBeenCalledWith('overlap', 100, {
      $and: [
        { doc_type: 'session_summary' },
        { $or: [{ project: 'search-project' }, { merged_into_project: 'search-project' }] },
        { platform_source: 'cursor' },
      ],
    });
    expect(getSessionSummariesByIds).toHaveBeenCalledWith([session.id], {
      orderBy: 'date_desc',
      limit: 10,
      project: 'search-project',
      projects: ['search-project'],
      platformSource: 'cursor',
    });
    expect(result.sessions).toEqual([session]);
  });

  it('passes platformSource into Chroma prompt SQLite hydration', async () => {
    const prompt = {
      id: 7,
      content_session_id: 'shared-raw-id',
      prompt_number: 1,
      prompt_text: 'cursor overlap prompt',
      project: 'search-project',
      platform_source: 'cursor',
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const getUserPromptsByIds = mock(() => [prompt]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [prompt.id],
      distances: [0.1],
      metadatas: [{
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        project: 'search-project',
        platform_source: 'cursor',
        created_at_epoch: Date.now(),
      }],
    }));

    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds,         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'overlap',
      type: 'prompts',
      project: 'search-project',
      platformSource: 'cursor',
      format: 'json',
      limit: 10,
    });

    expect(getUserPromptsByIds).toHaveBeenCalledWith([prompt.id], {
      orderBy: 'date_desc',
      limit: 10,
      project: 'search-project',
      projects: ['search-project'],
      platformSource: 'cursor',
    });
    expect(result.prompts).toEqual([prompt]);
  });

  it('passes platformSource into getTimelineByQuery auto-mode hydration', async () => {
    const observation = {
      id: 8,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'cursor timeline anchor',
      subtitle: null,
      facts: '[]',
      narrative: 'cursor timeline narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const searchObservations = mock(() => [observation]);
    const getTimelineAroundObservation = mock(() => ({
      observations: [],
      sessions: [],
      prompts: [],
    }));

    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),         getProjectReadKeys: (projects: string[]) => projects,
        getTimelineAroundObservation,
      } as any,
      null,
      {} as any,
      { filterByDepth: mock(() => []) } as any,
    );

    await manager.getTimelineByQuery({
      query: 'timeline',
      mode: 'auto',
      project: 'search-project',
      platform_source: 'cursor',
    });

    expect(searchObservations).toHaveBeenCalledWith('timeline', {
      project: 'search-project',
      platformSource: 'cursor',
      limit: 1,
    });
    expect(getTimelineAroundObservation).toHaveBeenCalledWith(
      observation.id,
      observation.created_at_epoch,
      10,
      10,
      'search-project',
      'cursor',
    );
  });

  it('falls back to scoped SQLite/FTS when platform-scoped Chroma returns zero matches', async () => {
    const observation = {
      id: 9,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'cursor fallback observation',
      subtitle: null,
      facts: '[]',
      narrative: 'cursor fallback narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const session = {
      id: 10,
      memory_session_id: 'cursor-memory-id',
      project: 'search-project',
      request: 'cursor fallback session',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const prompt = {
      id: 11,
      content_session_id: 'shared-raw-id',
      prompt_number: 1,
      prompt_text: 'cursor fallback prompt',
      project: 'search-project',
      platform_source: 'cursor',
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => [session]);
    const searchUserPrompts = mock(() => [prompt]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: [],
    }));

    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions,
        searchUserPrompts,
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );
    const telemetry = {};

    const result = await manager.search({
      query: 'legacy metadata',
      project: 'search-project',
      platformSource: 'cursor',
      format: 'json',
      limit: 10,
    }, telemetry);

    expect(searchObservations).toHaveBeenCalledWith('legacy metadata', expect.objectContaining({
      project: 'search-project',
      platformSource: 'cursor',
    }));
    expect(searchSessions).toHaveBeenCalledWith('legacy metadata', expect.objectContaining({
      project: 'search-project',
      platformSource: 'cursor',
    }));
    expect(searchUserPrompts).toHaveBeenCalledWith('legacy metadata', expect.objectContaining({
      project: 'search-project',
      platformSource: 'cursor',
    }));
    expect(result).toEqual(expect.objectContaining({
      observations: [observation],
      sessions: [session],
      prompts: [prompt],
      totalResults: 3,
    }));
    expect(telemetry).toEqual(expect.objectContaining({
      result_count: 3,
      search_strategy: 'fts',
      chroma_available: true,
      fallback_reason: 'chroma_zero_results',
    }));
  });

  it('falls back to unscoped SQLite/FTS when unscoped Chroma returns zero matches', async () => {
    const observation = {
      id: 12,
      memory_session_id: 'unscoped-memory-id',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'unscoped fallback observation',
      subtitle: null,
      facts: '[]',
      narrative: 'unscoped fallback narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: [],
    }));

    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions,
        searchUserPrompts,
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );
    const telemetry = {};

    const result = await manager.search({
      query: 'legacy metadata',
      format: 'json',
    }, telemetry);

    expect(searchObservations).toHaveBeenCalledWith('legacy metadata', expect.objectContaining({}));
    expect(result).toEqual(expect.objectContaining({
      observations: [observation],
      totalResults: 1,
    }));
    expect(telemetry).toEqual(expect.objectContaining({
      result_count: 1,
      search_strategy: 'fts',
      chroma_available: true,
      fallback_reason: 'chroma_zero_results',
    }));
  });

  it('falls back to FTS5 when Chroma returns candidates but none survive the date-range filter', async () => {
    const observation = {
      id: 13,
      memory_session_id: 'old-memory-id',
      project: 'search-project',
      text: null,
      type: 'discovery',
      title: 'old glossary observation',
      subtitle: null,
      facts: '[]',
      narrative: 'old glossary narrative',
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(0).toISOString(),
      created_at_epoch: 0,
    };
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    // Chroma returns a non-empty candidate set (nearest-neighbor match on
    // today's unrelated session content), but its created_at_epoch is
    // "today" -- entirely outside the caller's requested historical
    // dateRange, so it must be filtered out by the recency check.
    const queryChroma = mock(() => Promise.resolve({
      ids: [999],
      distances: [0.2],
      metadatas: [{
        sqlite_id: 999,
        doc_type: 'observation',
        project: 'search-project',
        created_at_epoch: Date.now(),
      }],
    }));

    const manager = new SearchManager(
      {
        searchObservations,
        searchSessions,
        searchUserPrompts,
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'glossary',
      project: 'search-project',
      dateRange: { start: '2020-01-01', end: '2020-12-31' },
      format: 'json',
    });

    expect(searchObservations).toHaveBeenCalledWith('glossary', expect.objectContaining({
      project: 'search-project',
    }));
    expect(result).toEqual(expect.objectContaining({
      observations: [observation],
      totalResults: 1,
    }));
  });

  // #3531 — SQLite reads compare project keys case-insensitively, but Chroma
  // metadata filters are exact, so every stored spelling is passed to Chroma.
  it('hands Chroma every stored spelling of the project', async () => {
    const queryChroma = mock(() => Promise.resolve({ ids: [], distances: [], metadatas: [] }));
    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
        getProjectReadKeys: () => ['pasteypal', 'PasteyPal'],
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    await manager.search({ query: 'overlap', type: 'observations', project: 'pasteypal', format: 'json', limit: 10 });

    const spellings = { $in: ['pasteypal', 'PasteyPal'] };
    expect(queryChroma).toHaveBeenCalledWith('overlap', 100, {
      $and: [
        { doc_type: 'observation' },
        { $or: [{ project: spellings }, { merged_into_project: spellings }] },
      ],
    });
  });

  // Gate P2-5: a checkout's search covers every key it reads (its current key
  // and the ones it wrote under before a re-key), in Chroma and in the SQLite
  // hydration alike.
  it('searches every project of a checkout and hydrates with the same keys', async () => {
    const observation = { id: 7, title: 'from the folder key', created_at_epoch: Date.now() };
    const queryChroma = mock(() => Promise.resolve({
      ids: [observation.id],
      distances: [0.1],
      metadatas: [{ sqlite_id: observation.id, doc_type: 'observation', project: 'api', created_at_epoch: Date.now() }],
    }));
    const getProjectReadKeys = mock((projects: string[]) => [...projects, 'old-folder']);
    const getObservationsByIds = mock(() => [observation]);
    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds,
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
        getProjectReadKeys,
      } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    await manager.search({ query: 'overlap', type: 'observations', project: 'acme/api', projects: 'api,acme/api', format: 'json', limit: 10 });

    expect(getProjectReadKeys).toHaveBeenCalledWith(['acme/api', 'api']);
    const keys = { $in: ['acme/api', 'api', 'old-folder'] };
    expect(queryChroma).toHaveBeenCalledWith('overlap', 100, {
      $and: [
        { doc_type: 'observation' },
        { $or: [{ project: keys }, { merged_into_project: keys }] },
      ],
    });
    expect(getObservationsByIds).toHaveBeenCalledWith([observation.id], expect.objectContaining({
      projects: ['acme/api', 'api', 'old-folder'],
    }));
  });
});

describe('SearchManager searchObservations date grouping', () => {
  const makeObservation = (id: number, title: string, createdAt: string) => ({
    id,
    memory_session_id: `session-${id}`,
    project: 'search-project',
    text: null,
    type: 'discovery',
    title,
    subtitle: null,
    facts: '[]',
    narrative: null,
    concepts: '[]',
    files_read: '[]',
    files_modified: '[]',
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: createdAt,
    created_at_epoch: new Date(createdAt).getTime(),
  });

  it('renders results under day headers so older results are not undated', async () => {
    const { FormattingService } = await import('../../src/services/worker/FormattingService.js');
    const { ModeManager } = await import('../../src/services/domain/ModeManager.js');
    ModeManager.getInstance().loadMode('code');
    const april = makeObservation(1, 'April observation', '2026-04-10T12:00:00Z');
    const august = makeObservation(2, 'August observation', '2026-08-22T12:00:00Z');

    const manager = new SearchManager(
      {
        searchObservations: mock(() => [august, april]),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
      new FormattingService(),
      {} as any,
    );

    const result = await manager.searchObservations({ query: 'observation' });
    const text = result.content[0].text;

    expect(text).toContain('Found 2 observation(s) matching "observation"');
    expect(text).toContain('### Apr 10, 2026');
    expect(text).toContain('### Aug 22, 2026');
    expect(text).toContain('April observation');
    expect(text).toContain('August observation');
  });

  it('keeps relevance order across day headers instead of sorting chronologically', async () => {
    const { FormattingService } = await import('../../src/services/worker/FormattingService.js');
    const { ModeManager } = await import('../../src/services/domain/ModeManager.js');
    ModeManager.getInstance().loadMode('code');
    // The search backend ranks the August match first because it is more
    // relevant, even though the April match is older. Day headers must not
    // undo that ranking by sorting the August group after the April group.
    const august = makeObservation(1, 'August observation', '2026-08-22T12:00:00Z');
    const april = makeObservation(2, 'April observation', '2026-04-10T12:00:00Z');

    const manager = new SearchManager(
      {
        searchObservations: mock(() => [august, april]),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
      new FormattingService(),
      {} as any,
    );

    const result = await manager.searchObservations({ query: 'observation' });
    const text = result.content[0].text;

    const augustHeaderIndex = text.indexOf('### Aug 22, 2026');
    const aprilHeaderIndex = text.indexOf('### Apr 10, 2026');
    expect(augustHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(aprilHeaderIndex).toBeGreaterThan(augustHeaderIndex);
  });
});

describe('SearchManager per-category SQLite supplement (unified /api/search path)', () => {
  const observation = {
    id: 21,
    memory_session_id: 'memory-21',
    project: 'supplement-project',
    text: null,
    type: 'discovery',
    title: 'fts supplement observation',
    subtitle: null,
    facts: '[]',
    narrative: 'found via fts supplement',
    concepts: '[]',
    files_read: '[]',
    files_modified: '[]',
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date().toISOString(),
    created_at_epoch: Date.now(),
  };
  const userPrompt = {
    id: 7,
    content_session_id: 'session-7',
    prompt_number: 1,
    prompt_text: 'テストを実行して',
    created_at: new Date().toISOString(),
    created_at_epoch: Date.now(),
  };

  function chromaReturningOnlyPrompt(promptId: number) {
    return mock(() => Promise.resolve({
      ids: [promptId],
      distances: [0.1],
      metadatas: [{ sqlite_id: promptId, doc_type: 'user_prompt', project: 'supplement-project', created_at_epoch: Date.now() }],
    }));
  }

  it('supplements empty observations from SQLite FTS when Chroma only surfaces prompts (CJK query)', async () => {
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);

    const manager = new SearchManager(
      { searchObservations, searchSessions, searchUserPrompts } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds,         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma: chromaReturningOnlyPrompt(userPrompt.id) } as any,
      {} as any,
      {} as any,
    );

    const telemetry = {};
    const result = await manager.search({ query: 'テスト', format: 'json', limit: 10 }, telemetry);

    expect(searchObservations).toHaveBeenCalledWith('テスト', expect.objectContaining({ limit: 10 }));
    expect(result.observations).toEqual([observation]);
    expect(result.prompts).toEqual([userPrompt]);
    expect(result.totalResults).toBe(2);
    expect(telemetry).toEqual(expect.objectContaining({
      result_count: 2,
      search_strategy: 'hybrid',
      chroma_available: true,
      fallback_reason: 'chroma_zero_results',
    }));
  });

  it('does not touch SQLite when every requested category already has Chroma matches', async () => {
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);

    const manager = new SearchManager(
      { searchObservations, searchSessions, searchUserPrompts } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds,         getProjectReadKeys: (projects: string[]) => projects,
      } as any,
      { queryChroma: chromaReturningOnlyPrompt(userPrompt.id) } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({ query: 'テスト', type: 'prompts', format: 'json', limit: 10 });

    expect(searchObservations).not.toHaveBeenCalled();
    expect(searchUserPrompts).not.toHaveBeenCalled();
    expect(result.prompts).toEqual([userPrompt]);
    expect(result.totalResults).toBe(1);
  });

  describe('against a real database', () => {
    let db: Database;
    let store: SessionStore;
    let sdkSessionId: number;

    function storeObservation(title: string, type: string): number {
      return store.storeObservation('supplement-mem', 'supplement-project', {
        type,
        title,
        subtitle: null,
        facts: [],
        narrative: `${title} narrative`,
        concepts: [],
        files_read: [],
        files_modified: [],
      }, 1).id;
    }

    function managerWithChroma(queryChroma: ReturnType<typeof mock>): SearchManager {
      return new SearchManager(new SessionSearch(db), store, { queryChroma } as any, {} as any, {} as any);
    }

    beforeEach(() => {
      db = new Database(':memory:');
      store = new SessionStore(db);
      sdkSessionId = store.createSDKSession('supplement-content', 'supplement-project', 'prompt');
      store.ensureMemorySessionIdRegistered(sdkSessionId, 'supplement-mem');
    });

    afterEach(() => {
      db.close();
    });

    // Plan-25's founding repro: Chroma's top-N for a CJK query is all prompts, so the
    // observations bucket comes back empty although the substring path finds the row.
    it('fills observations from the CJK substring path when Chroma only returns a prompt', async () => {
      storeObservation('用户身份验证流程', 'discovery');
      const promptId = store.saveUserPrompt('supplement-content', 2, '检查用户身份验证', sdkSessionId);

      const result = await managerWithChroma(chromaReturningOnlyPrompt(promptId))
        .search({ query: '用户身份', format: 'json' });

      expect(result.observations.map((o: { title: string }) => o.title)).toEqual(['用户身份验证流程']);
      expect(result.prompts.map((p: { id: number }) => p.id)).toEqual([promptId]);
    });

    it('refills observations when the obs_type filter excludes every Chroma candidate', async () => {
      const discoveryId = storeObservation('cache eviction discovery', 'discovery');
      storeObservation('cache eviction bugfix', 'bugfix');
      const queryChroma = mock(() => Promise.resolve({
        ids: [discoveryId],
        distances: [0.1],
        metadatas: [{ sqlite_id: discoveryId, doc_type: 'observation', project: 'supplement-project', created_at_epoch: Date.now() }],
      }));

      const result = await managerWithChroma(queryChroma)
        .search({ query: 'cache eviction', obs_type: 'bugfix', format: 'json' });

      expect(result.observations.map((o: { title: string }) => o.title)).toEqual(['cache eviction bugfix']);
    });

    it('caps the supplemented category at the requested limit', async () => {
      for (let i = 1; i <= 8; i++) storeObservation(`队列积压排查 ${i}`, 'discovery');
      const promptId = store.saveUserPrompt('supplement-content', 2, '队列为什么积压', sdkSessionId);

      const result = await managerWithChroma(chromaReturningOnlyPrompt(promptId))
        .search({ query: '队列', limit: 3, format: 'json' });

      expect(result.observations).toHaveLength(3);
      expect(result.prompts.map((p: { id: number }) => p.id)).toEqual([promptId]);
    });
  });
});

describe('SearchManager dates survive a host whose date formatter cannot initialize (#4126)', () => {
  // Bun/JavaScriptCore on Windows with an unresolvable system time zone: every
  // toLocale* call throws. #4126 guarded the shared helpers; these four dates
  // in SearchManager still called toLocaleString() directly.
  const ts = '2025-01-04T21:34:56.000Z';
  const originalToLocaleString = Date.prototype.toLocaleString;

  beforeEach(() => {
    Date.prototype.toLocaleString = (() => {
      throw new TypeError('failed to initialize DateTimeFormat');
    }) as typeof Date.prototype.toLocaleString;
  });

  afterEach(() => {
    Date.prototype.toLocaleString = originalToLocaleString;
  });

  it('renders recent session context instead of failing', async () => {
    const manager = new SearchManager(
      {} as any,
      {
        getRecentSessionsWithStatus: () => [
          { memory_session_id: 'summarized', has_summary: true, status: 'completed', started_at: ts, user_prompt: 'one' },
          { memory_session_id: 'running', has_summary: false, status: 'active', started_at: ts, user_prompt: 'two' },
          { memory_session_id: 'stopped', has_summary: false, status: 'failed', started_at: ts, user_prompt: 'three' },
        ],
        getSummaryForSession: () => ({ request: 'Fix the worker', created_at: ts, prompt_number: 1 }),
        getObservationsForSession: () => [],
      } as any,
      null,
      {} as any,
      {} as any,
    );

    const rendered = await manager.getRecentContext({ project: 'dates-project', limit: 3 });
    const text = rendered.content[0].text as string;

    expect(text.match(/\*\*Date:\*\* 2025-01-04 9:34 PM UTC/g)).toHaveLength(3);
  });

  it('renders timeline anchor matches instead of failing', async () => {
    const manager = new SearchManager(
      {
        searchObservations: () => [{ id: 7, title: 'Anchor', subtitle: null, type: 'bugfix', created_at_epoch: Date.parse(ts) }],
      } as any,
      {} as any,
      null,
      {} as any,
      {} as any,
    );

    const rendered = await manager.getTimelineByQuery({ query: 'anchor', mode: 'interactive' });
    const text = rendered.content[0].text as string;

    expect(text).toContain('   - Date: 2025-01-04 9:34 PM UTC');
  });
});
