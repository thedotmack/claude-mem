import { describe, it, expect, mock } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

// A date-only end bound means "through the end of that day" (resolveDateBound). The Chroma
// path of unified search must read it the same way SQLite does, or a same-day range keeps
// only the exact midnight millisecond and drops every Chroma hit from that day.
describe('SearchManager Chroma date window', () => {
  const noonOnJan1 = Date.parse('2025-01-01T12:00:00.000Z');
  const observation = {
    id: 5,
    memory_session_id: 'memory-5',
    project: 'date-project',
    text: null,
    type: 'discovery',
    title: 'midday observation',
    subtitle: null,
    facts: '[]',
    narrative: 'written at noon',
    concepts: '[]',
    files_read: '[]',
    files_modified: '[]',
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date(noonOnJan1).toISOString(),
    created_at_epoch: noonOnJan1,
  };

  it('keeps a Chroma hit from later in the day named by a date-only end bound', async () => {
    const searchObservations = mock(() => []);
    const getObservationsByIds = mock(() => [observation]);
    const queryChroma = mock(() => Promise.resolve({
      ids: [observation.id],
      distances: [0.1],
      metadatas: [{ sqlite_id: observation.id, doc_type: 'observation', project: 'date-project', created_at_epoch: noonOnJan1 }],
    }));

    const manager = new SearchManager(
      { searchObservations, searchSessions: mock(() => []), searchUserPrompts: mock(() => []) } as any,
      { getObservationsByIds, getSessionSummariesByIds: mock(() => []), getUserPromptsByIds: mock(() => []) } as any,
      { queryChroma } as any,
      {} as any,
      {} as any,
    );

    const result = await manager.search({
      query: 'midday',
      type: 'observations',
      dateStart: '2025-01-01',
      dateEnd: '2025-01-01',
      format: 'json',
    });

    expect(getObservationsByIds).toHaveBeenCalledWith([observation.id], expect.anything());
    expect(result.observations).toEqual([observation]);
  });
});
