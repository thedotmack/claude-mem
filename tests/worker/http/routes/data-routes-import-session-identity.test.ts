import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const contentId = 'shared-content-session';
const project = 'import-project';

function exportedMemory(platform = 'claude') {
  const source = new SessionStore(':memory:');
  try {
    const memoryId = `exported-${platform}-memory`;
    const sessionId = source.createSDKSession(contentId, project, 'Exported prompt', 'Backup title', platform);
    source.ensureMemorySessionIdRegistered(sessionId, memoryId);
    const observationId = source.storeObservation(memoryId, project, {
      type: 'discovery', title: `Recovered ${platform} knowledge`, subtitle: null,
      narrative: 'Historical retry policy', facts: ['Use exponential backoff'],
      concepts: [], files_read: [], files_modified: [],
    }, 2).id;
    const summaryId = source.storeSummary(memoryId, project, {
      request: `Recovered ${platform} summary`, investigated: 'Retries', learned: 'Backoff',
      completed: 'Retry policy', next_steps: 'Add monitoring', notes: null,
    }, 2).id;
    const promptId = source.saveUserPrompt(contentId, 2, 'Exported retry prompt', sessionId);
    return {
      sessions: source.getSdkSessionsBySessionIds([memoryId]),
      observations: source.getObservationsByIds([observationId]),
      summaries: source.getSessionSummariesByIds([summaryId]),
      prompts: source.getUserPromptsByIds([promptId]),
    };
  } finally {
    source.close();
  }
}

describe('memory import into an existing content session', () => {
  let store: SessionStore;
  let server: Server;
  let baseUrl: string;
  const syncObservation = mock(async (..._args: unknown[]) => {});

  beforeEach(async () => {
    store = new SessionStore(':memory:');
    syncObservation.mockClear();
    const app = express();
    app.use(express.json());
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getChromaSync: () => ({ syncObservation }) } as any,
      {} as any, {} as any, {} as any, Date.now(),
    );
    routes.setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });

  async function importMemory(payload: ReturnType<typeof exportedMemory>) {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  it.each([null, 'local-memory', 'exported-claude-memory'])('restores searchable memories without replacing local state (memory id=%s)', async (localMemoryId) => {
    const payload = exportedMemory();
    const sessionId = store.createSDKSession(contentId, project, 'Local prompt', 'Local title');
    const localPromptId = store.saveUserPrompt(contentId, 1, 'Local prompt', sessionId);
    if (localMemoryId) store.ensureMemorySessionIdRegistered(sessionId, localMemoryId);
    const localObservationId = localMemoryId ? store.storeObservation(localMemoryId, project, {
      type: 'decision', title: 'Existing local knowledge', subtitle: null,
      narrative: 'Keep this memory', facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1).id : undefined;
    const localObservation = localObservationId ? store.getObservationById(localObservationId) : undefined;
    const memoryId = localMemoryId ?? payload.sessions[0].memory_session_id;
    const before = store.getSessionById(sessionId)!;
    const restored = await importMemory(payload);

    expect(restored.stats).toMatchObject({
      sessionsImported: 0, sessionsSkipped: 1, sessionsRejected: 0,
      observationsImported: 1, observationsRejected: 0,
      summariesImported: 1, summariesRejected: 0, promptsImported: 1, promptsRejected: 0,
    });
    expect(store.getSessionById(sessionId)).toEqual({ ...before, memory_session_id: memoryId });
    expect(store.getUserPromptById(localPromptId)?.prompt_text).toBe('Local prompt');
    expect(store.getObservationsForSession(memoryId!)).toHaveLength(localObservation ? 2 : 1);
    if (localObservationId) expect(store.getObservationById(localObservationId)).toEqual(localObservation);
    expect(store.getSummaryForSession(memoryId!)?.learned).toBe('Backoff');
    expect(store.getUserPrompt(contentId, 2, sessionId)).toBe('Exported retry prompt');
    expect(store.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 1 });
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);

    const search = new SessionSearch(store.db);
    expect(search.searchObservations('Recovered', { project }).map(row => row.memory_session_id)).toEqual([memoryId]);
    expect(search.searchSessions('Recovered', { project }).map(row => row.memory_session_id)).toEqual([memoryId]);
    expect(syncObservation).toHaveBeenCalledTimes(1);
    expect(syncObservation.mock.calls[0][1]).toBe(memoryId);
    expect(syncObservation.mock.calls[0][6]).toBe('claude');

    const replayed = await importMemory(payload);
    expect(replayed.stats).toMatchObject({
      sessionsSkipped: 1, observationsImported: 0, observationsSkipped: 1,
      summariesImported: 0, summariesSkipped: 1, promptsImported: 0, promptsSkipped: 1,
      observationsRejected: 0, summariesRejected: 0, promptsRejected: 0,
    });
    expect(syncObservation).toHaveBeenCalledTimes(1);
  });

  it('keeps overlapping Claude and Cursor content ids in their own existing sessions', async () => {
    const claude = exportedMemory('claude');
    const cursor = exportedMemory('cursor');
    const payload = {
      sessions: [...claude.sessions, ...cursor.sessions],
      observations: [...claude.observations, ...cursor.observations],
      summaries: [...claude.summaries, ...cursor.summaries],
      prompts: [...claude.prompts, ...cursor.prompts],
    };
    for (const platform of ['claude', 'cursor']) {
      const sessionId = store.createSDKSession(contentId, project, 'Local prompt', undefined, platform);
      store.ensureMemorySessionIdRegistered(sessionId, `local-${platform}-memory`);
    }
    const restored = await importMemory(payload);
    expect(restored.stats).toMatchObject({
      sessionsSkipped: 2, observationsImported: 2, observationsRejected: 0,
      summariesImported: 2, summariesRejected: 0, promptsImported: 2, promptsRejected: 0,
    });
    for (const platform of ['claude', 'cursor']) {
      const memoryId = `local-${platform}-memory`;
      expect(store.getObservationsForSession(memoryId, platform).map(row => row.title)).toEqual([`Recovered ${platform} knowledge`]);
      expect(store.getSummaryForSession(memoryId, platform)?.request).toBe(`Recovered ${platform} summary`);
    }
    expect(store.db.query(`
      SELECT s.platform_source, up.prompt_number FROM user_prompts up
      JOIN sdk_sessions s ON s.id = up.session_db_id ORDER BY s.platform_source
    `).all()).toEqual([
      { platform_source: 'claude', prompt_number: 2 },
      { platform_source: 'cursor', prompt_number: 2 },
    ]);
    expect(syncObservation.mock.calls.map(call => [call[1], call[6]])).toEqual([
      ['local-claude-memory', 'claude'], ['local-cursor-memory', 'cursor'],
    ]);
    expect(store.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 2 });
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('still rejects memories whose exported parent session is missing', async () => {
    const payload = exportedMemory();
    const restored = await importMemory({ ...payload, sessions: [], prompts: [] });
    expect(restored.stats).toMatchObject({
      observationsImported: 0, observationsRejected: 1, summariesImported: 0, summariesRejected: 1,
    });
    expect(restored.rejected.observations[0].reason).toContain('FOREIGN KEY constraint failed');
    expect(restored.rejected.summaries[0].reason).toContain('FOREIGN KEY constraint failed');
    expect(store.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
    expect(syncObservation).not.toHaveBeenCalled();
  });
});
