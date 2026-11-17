import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const project = 'restored-project';
const observation = {
  type: 'decision', title: 'Restored Café decision', subtitle: null,
  narrative: 'Keep the recorded decision', facts: [], concepts: [],
  files_read: ['src/main.ts'], files_modified: [],
};

function exported(name = 'saved', platform = 'claude', agent: Record<string, string> = {}) {
  const source = new SessionStore(':memory:');
  try {
    const session = source.createSDKSession(name, project, 'Original prompt', undefined, platform);
    source.ensureMemorySessionIdRegistered(session, name);
    const row = source.storeObservation(name, project, { ...observation, ...agent }, 1, 0, 1_700_000_000_000);
    return { sessions: source.getSdkSessionsBySessionIds([name]), observations: source.getObservationsByIds([row.id]) };
  } finally { source.close(); }
}

describe('restored observations participate in future deduplication', () => {
  let store: SessionStore;
  let server: Server;
  let baseUrl: string;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.CLAUDE_MEM_DEDUP_ENABLED;
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    store = new SessionStore(':memory:');
    const app = express();
    app.use(express.json());
    new DataRoutes({} as any, { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    if (previous === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
    else process.env.CLAUDE_MEM_DEDUP_ENABLED = previous;
  });

  async function restore(payload: ReturnType<typeof exported>) {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  function capture(name: string, platform = 'claude', agent: Record<string, string> = {}, title = observation.title) {
    const session = store.createSDKSession(name, project, 'Later prompt', undefined, platform);
    store.ensureMemorySessionIdRegistered(session, name);
    return store.storeObservation(name, project, { ...observation, title, ...agent });
  }

  function importedId(memory = 'saved'): number {
    return (store.db.query('SELECT id FROM observations WHERE memory_session_id = ?').get(memory) as { id: number }).id;
  }

  it('reuses an imported canonical row on the next session and counts the restored document once', async () => {
    const payload = exported();
    expect((await restore(payload)).stats.observationsImported).toBe(1);
    const id = importedId();
    const later = capture('later', 'claude', {}, 'RESTORED Cafe\u0301 decision.');
    expect(later).toMatchObject({ id, mergedIntoExisting: true });
    expect(store.db.query('SELECT occurrence_count FROM observations WHERE id = ?').get(id)).toEqual({ occurrence_count: 2 });
    expect(store.db.query('SELECT doc_count FROM dedup_meta WHERE project = ?').get(project)).toEqual({ doc_count: 1 });
    expect(store.db.query("SELECT df FROM token_df WHERE project = ? AND token = 'restored'").get(project)).toEqual({ df: 1 });
    expect(store.getObservationById(id)?.narrative).toBe(observation.narrative);
  });

  it('builds the title key while disabled, as ordinary capture does', async () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'false';
    await restore(exported());
    const id = importedId();
    expect(store.db.query('SELECT count(*) AS n FROM dedup_meta').get()).toEqual({ n: 0 });
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    expect(capture('later')).toMatchObject({ id, mergedIntoExisting: true });
  });

  it('preserves historical duplicate rows and keeps model counts unchanged on import replay', async () => {
    const first = exported('first');
    const second = exported('second');
    const payload = { sessions: [...first.sessions, ...second.sessions], observations: [...first.observations, ...second.observations] };
    expect((await restore(payload)).stats.observationsImported).toBe(2);
    expect((await restore(payload)).stats.observationsSkipped).toBe(2);
    expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 2 });
    expect(store.db.query('SELECT doc_count FROM dedup_meta WHERE project = ?').get(project)).toEqual({ doc_count: 2 });
    expect(store.db.query("SELECT df FROM token_df WHERE project = ? AND token = 'restored'").get(project)).toEqual({ df: 2 });
    expect(capture('later')).toMatchObject({ id: importedId('first'), mergedIntoExisting: true });
  });

  it('derives the platform and agent scope from the restored row and its actual parent', async () => {
    const payload = exported('saved', 'cursor', { agent_id: 'saved-agent', agent_type: 'Explore' });
    (payload.observations[0] as any).platform_source = 'claude';
    await restore(payload);
    const id = importedId();
    expect(capture('other-platform', 'claude', { agent_id: 'new-agent', agent_type: 'Explore' }).id).not.toBe(id);
    expect(capture('main-agent', 'cursor').id).not.toBe(id);
    expect(capture('same-scope', 'cursor', { agent_id: 'another-agent', agent_type: 'Plan' }))
      .toMatchObject({ id, mergedIntoExisting: true });
  });

  it.each([[123, '123'], [true, '1']] as const)('indexes the SQLite text representation of legacy title %s', async (value, title) => {
    const payload = exported();
    (payload.observations[0] as any).title = value;
    expect((await restore(payload)).stats.observationsImported).toBe(1);
    expect(capture('later', 'claude', {}, title)).toMatchObject({ id: importedId(), mergedIntoExisting: true });
  });

  it('retains a historical untitled row without giving it a merging key', async () => {
    const payload = exported();
    payload.observations[0].title = null;
    expect((await restore(payload)).stats.observationsImported).toBe(1);
    expect(store.db.query('SELECT title, title_norm_key FROM observations').get()).toEqual({ title: null, title_norm_key: null });
  });
});
