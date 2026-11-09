import { describe, expect, it } from 'bun:test';
import { SearchManager, type SearchTelemetryEnvelope } from '../../../src/services/worker/SearchManager.js';

const observation = {
  id: 5,
  memory_session_id: 'memory',
  project: 'app',
  type: 'discovery',
  title: 'Semantic memory match',
  created_at: new Date().toISOString(),
  created_at_epoch: Date.now(),
};

function fixture(options: {
  semanticMatch?: boolean;
  sqliteFailure?: Error;
  chromaFailure?: Error;
  sessions?: Array<{ id: number }>;
} = {}) {
  const calls = { observations: 0, sessions: 0 };
  const manager = new SearchManager({
    searchObservations() { calls.observations++; return []; },
    searchSessions() {
      calls.sessions++;
      if (options.sqliteFailure) throw options.sqliteFailure;
      return options.sessions ?? [];
    },
    searchUserPrompts: () => [],
  } as any, {
    getObservationsByIds: () => [observation],
    getSessionSummariesByIds: () => [],
    getUserPromptsByIds: () => [],
    getProjectReadKeys: (projects: string[]) => projects,
  } as any, {
    async queryChroma() {
      if (options.chromaFailure) throw options.chromaFailure;
      return options.semanticMatch === false
        ? { ids: [], distances: [], metadatas: [] }
        : {
            ids: [observation.id],
            distances: [0.1],
            metadatas: [{
              sqlite_id: observation.id,
              doc_type: 'observation',
              project: 'app',
              created_at_epoch: observation.created_at_epoch,
            }],
          };
    },
  } as any, {} as any, {} as any);
  return { manager, calls };
}

const searchArgs = {
  query: 'memory',
  type: ['observations', 'sessions'],
  project: 'app',
  format: 'json',
  limit: 10,
};

describe('SearchManager SQLite supplementation failures', () => {
  it('propagates a failed category refill without discarding semantic matches in a second keyword fallback', async () => {
    const failure = new Error('database is locked');
    const { manager, calls } = fixture({ sqliteFailure: failure });
    let caught: unknown;
    try { await manager.search(searchArgs); }
    catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(calls).toEqual({ observations: 0, sessions: 1 });
  });

  it('propagates a failed SQLite search after a successful zero-match Chroma response', async () => {
    const failure = new Error('database disk image is malformed');
    const { manager, calls } = fixture({ semanticMatch: false, sqliteFailure: failure });
    let caught: unknown;
    try { await manager.search(searchArgs); }
    catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(calls).toEqual({ observations: 1, sessions: 1 });
  });

  it('preserves semantic matches and telemetry for successful empty or populated refills', async () => {
    for (const sessions of [[], [{ id: 7 }]]) {
      const { manager, calls } = fixture({ sessions });
      const telemetry: SearchTelemetryEnvelope = {};
      const result = await manager.search(searchArgs, telemetry);
      expect(result.observations).toEqual([observation]);
      expect(result.sessions).toEqual(sessions);
      expect(result.totalResults).toBe(1 + sessions.length);
      expect(calls).toEqual({ observations: 0, sessions: 1 });
      expect(telemetry.search_strategy).toBe(sessions.length ? 'hybrid' : 'chroma');
      expect(telemetry.chroma_available).toBe(true);
    }
  });

  it('retains the existing tolerant keyword fallback when Chroma itself fails', async () => {
    const { manager, calls } = fixture({
      chromaFailure: new Error('Chroma connection failed'),
      sqliteFailure: new Error('keyword fallback unavailable'),
    });
    const telemetry: SearchTelemetryEnvelope = {};
    const result = await manager.search(searchArgs, telemetry);
    expect(result.totalResults).toBe(0);
    expect(calls).toEqual({ observations: 1, sessions: 1 });
    expect(telemetry.search_strategy).toBe('fts');
    expect(telemetry.chroma_available).toBe(false);
  });
});
