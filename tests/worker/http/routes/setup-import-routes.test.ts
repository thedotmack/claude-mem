// POST /api/setup/import/stop, Finish Setup's "Stop import" (plan Phase 8, E9): the setup routes' guards, a plain answer
// when nothing runs, and a stop that leaves nothing running and starts nothing by itself.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { HISTORY_IMPORT_BATCH, HistoryImport } from '../../../../src/services/setup/history-import.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { HISTORY_IMPORT_RUN_STATES } from '../../../../src/shared/setup-funnel.js';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', '..', 'fixtures', 'prompt-import', 'home');
// Project-local scratch (gitignored), never the system temp folder.
const scratchRoot = join(import.meta.dir, '..', '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const dir = mkdtempSync(join(scratchRoot, 'setup-import-routes-'));
const statePath = join(dir, 'setup-state.json');
const settingsPath = join(dir, 'settings.json');

let server: Server;
let routes: WorkViewRoutes;
let origin: string;
let store: SessionStore;
/** Every request the history import sent to the fake cmem.ai, with its cancel signal. */
let imports: AbortSignal[];

beforeEach(() => {
  store = new SessionStore(':memory:');
  const id = store.createSDKSession('c-route', 'route', 'prompt');
  store.updateMemorySessionId(id, 'm-route');
  for (let index = 0; index < HISTORY_IMPORT_BATCH * 2 + 1; index++) {
    store.storeObservation('m-route', 'route', { type: 'discovery', title: `route ${index}`, subtitle: null, facts: [], narrative: 'n', concepts: [], files_read: [], files_modified: [] }, 1, 0);
  }
  imports = [];
});

/** The fake cmem.ai holds every import request open until it is cancelled, so the upload runs until Stop. */
const holdingCmem = (async (_url: string, init: RequestInit) => {
  imports.push(init.signal!);
  return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
}) as unknown as typeof fetch;

async function start(historyImport: HistoryImport | null) {
  routes = new WorkViewRoutes({
    databasePath: join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: null, setupScan: null, setupStatePath: statePath, settingsPath, autoRefresh: null as never, historyImport,
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
  rmSync(statePath, { force: true });
  rmSync(settingsPath, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const state = async () => (await fetch(`${origin}/api/setup/state`)).json();
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
}
const historyImport = () => new HistoryImport({
  openDatabase: () => ({ prepare: store.db.prepare.bind(store.db), close() {} }) as never,
  origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: holdingCmem,
});
/** On The Go is chosen and the upload is running, with its first batch on its way to cmem.ai. */
async function importRunning() {
  expect((await post('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' })).status).toBe(200);
  expect((await post('/api/setup/import', {})).status).toBe(202);
  expect((await state()).historyImport.state).toBe('running');
  expect(imports).toHaveLength(1);
}

describe('POST /api/setup/import/stop', () => {
  it('answers 503 on a worker without the history import', async () => {
    await start(null);
    const response = await post('/api/setup/import/stop', {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Bringing your memory is unavailable on this worker.' });
  });

  it('says plainly that there is nothing to stop when no upload runs', async () => {
    await start(historyImport());
    const response = await post('/api/setup/import/stop', {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'No import is running, so there is nothing to stop.' });
    expect((await state()).historyImport.state).toBe('idle');
    expect(imports).toHaveLength(0);
  });

  it('refuses requests from off this computer, from another page and with a body, and they stop nothing', async () => {
    await start(historyImport());
    await importRunning();
    // Loopback only: a proxied request or a foreign Host.
    for (const headers of [{ 'X-Forwarded-For': '127.0.0.1' }, { Forwarded: 'for=127.0.0.1' }, { Host: 'evil.example' }]) {
      expect((await post('/api/setup/import/stop', {}, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    // The setup page's own origin only, and only JSON.
    for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' }]) {
      expect((await post('/api/setup/import/stop', {}, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    // The body is empty: anything in it is refused.
    expect((await post('/api/setup/import/stop', { now: true })).status).toBe(400);
    const view = await state();
    expect(view.historyImport.state).toBe('running');
    expect(view.backgroundWorkRunning).toEqual(['history-import']);
    expect(imports[0].aborted).toBe(false);
  });

  it('ends the upload at once: no request after it, nothing counted as running, and nothing starts it again by itself', async () => {
    const upload = historyImport();
    await start(upload);
    const frames: Array<{ state: string }> = [];
    (routes as unknown as { broadcast: (event: string, value: unknown) => void }).broadcast = (event, value) => {
      if (event === 'setup-import') frames.push(value as { state: string });
    };
    await importRunning();

    const response = await post('/api/setup/import/stop', {});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const stopped = await response.json();
    expect(HISTORY_IMPORT_RUN_STATES).toContain(stopped.state);
    expect(stopped).toMatchObject({ state: 'stopped', total: HISTORY_IMPORT_BATCH * 2 + 1, sent: 0, unconfirmed: HISTORY_IMPORT_BATCH, error: null });
    expect(imports[0].aborted).toBe(true);
    // The page hears it on the event stream too, and the installer no longer waits for it.
    expect(frames.at(-1)).toMatchObject({ state: 'stopped', unconfirmed: HISTORY_IMPORT_BATCH });
    const view = await state();
    expect(view.historyImport).toEqual(stopped);
    expect(view.backgroundWorkRunning).toEqual([]);

    // A second Stop finds nothing running; reading the state and waiting start nothing.
    expect((await post('/api/setup/import/stop', {})).status).toBe(409);
    await new Promise(resolve => setTimeout(resolve, 50));
    await state();
    expect(imports).toHaveLength(1);
    expect((await state()).historyImport.state).toBe('stopped');

    // Starting again is the person's own request.
    expect((await post('/api/setup/import', {})).status).toBe(202);
    expect(imports).toHaveLength(2);
    expect((await state()).historyImport.state).toBe('running');
    upload.stop();
  });
});
