// Funnel Phase 9: "Bring your existing memory" uploads this machine's own observations through cmem.ai /api/import.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { HISTORY_IMPORT_BATCH, HistoryImport, readHistoryCounts } from '../../../src/services/setup/history-import.js';

let store: SessionStore;
beforeEach(() => { store = new SessionStore(':memory:'); });
afterEach(() => store.close());

function seed(project: string, count: number) {
  const id = store.createSDKSession(`c-${project}`, project, 'prompt');
  store.updateMemorySessionId(id, `m-${project}`);
  for (let index = 0; index < count; index++) {
    store.storeObservation(`m-${project}`, project, { type: 'discovery', title: `${project} ${index}`, subtitle: null, facts: ['a fact'], narrative: `narrative ${index}`, concepts: [], files_read: [], files_modified: [] }, 1, 0, 1_700_000_000_000 + index);
  }
}

/** A handle the import may close without closing the test store. */
const handle = () => ({ prepare: store.db.prepare.bind(store.db), close() {} }) as never;

describe('history import', () => {
  it('counts only this machine\'s own observations', () => {
    seed('alpha', 3);
    seed('beta', 2);
    store.db.prepare("UPDATE observations SET origin_device_id = 'other-device' WHERE title = 'beta 1'").run();
    expect(readHistoryCounts(store.db)).toEqual({ projects: 2, sessions: 2, observations: 4 });
  });

  it('sends observations in batches with the setup token and reports what cmem.ai imported', async () => {
    seed('alpha', HISTORY_IMPORT_BATCH + 20);
    const requests: Array<{ url: string; authorization: string | null; count: number; first: any }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url, authorization: new Headers(init.headers).get('authorization'), count: body.observations.length, first: body.observations[0] });
      expect(Object.keys(body)).toEqual(['observations']);
      return Response.json({ ok: true, stats: { observationsImported: body.observations.length - 1, observationsSkipped: 1 } });
    }) as unknown as typeof fetch;
    const run = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: fetchImpl });
    const events: string[] = [];
    run.subscribe(state => events.push(state.state));
    run.start();
    const done = await run.finished();

    expect(requests.map(request => request.count)).toEqual([HISTORY_IMPORT_BATCH, 20]);
    expect(requests.every(request => request.url === 'https://cmem.test/api/import' && request.authorization === 'Bearer cm_pro_token')).toBe(true);
    expect(requests[0].first).toMatchObject({ memory_session_id: 'm-alpha', project: 'alpha', type: 'discovery', title: 'alpha 0', narrative: 'narrative 0', prompt_number: '1', created_at_epoch: 1_700_000_000_000 });
    expect(done).toMatchObject({ state: 'done', total: HISTORY_IMPORT_BATCH + 20, sent: HISTORY_IMPORT_BATCH + 20, imported: HISTORY_IMPORT_BATCH + 18, skipped: 2, percent: 100, error: null });
    expect(events[0]).toBe('running');
  });

  it('a refused batch stops the run with the server\'s reason; no token means checkout comes first', async () => {
    seed('alpha', 2);
    const refused = new HistoryImport({
      openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token',
      fetch: (async () => Response.json({ error: 'invalid_token' }, { status: 401 })) as unknown as typeof fetch,
    });
    refused.start();
    expect(await refused.finished()).toMatchObject({ state: 'failed', sent: 0, error: 'cmem.ai refused the import (HTTP 401: invalid_token).' });

    const noToken = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => null });
    expect(() => noToken.start()).toThrow(/Finish checkout first/);
  });
});
