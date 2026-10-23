// Funnel Phase 5: a finished setup scan starts the extraction once, and the snapshot carries setup.{scan, extraction}.
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { SetupScan } from '../../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import type { AutoRefreshWorker } from '../../../../src/services/work-view/auto-refresh-worker.mjs';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', '..', 'fixtures', 'prompt-import', 'home');

let server: Server;
let routes: WorkViewRoutes;
let store: SessionStore;
let origin: string;

/** Stands in for the refresh worker: records runNow calls and reports the status a test sets. */
function fakeRefresh() {
  const fake = {
    revision: 0, runs: [] as string[], current: null as Record<string, unknown> | null,
    start() {}, close() {}, status() { return fake.current; },
    async runNow({ reason }: { reason: string }) {
      fake.runs.push(reason);
      fake.current = { state: 'waiting-for-agent', reason, error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.' };
      fake.revision++;
      return 'waiting-for-agent';
    },
  };
  return fake;
}

async function start(refresh: ReturnType<typeof fakeRefresh>) {
  store = new SessionStore(':memory:');
  let clock = Date.parse('2026-10-10T00:00:00.000Z');
  const setupScan = new SetupScan({
    getStore: () => store, now: () => (clock += 1000), progressIntervalMs: 0,
    scanOptions: { homeDirectory: FIXTURE_HOME, resolveProject: () => 'fixture' },
  });
  routes = new WorkViewRoutes({
    databasePath: join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: null, setupScan, autoRefresh: refresh as unknown as AutoRefreshWorker,
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
  return setupScan;
}

afterEach(async () => {
  routes.close();
  store?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const postScan = () => fetch(`${origin}/api/setup/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
const snapshot = async () => (await fetch(`${origin}/api/work-view`)).json() as Promise<any>;

describe('setup extraction', () => {
  it('starts once when the scan finishes, and the snapshot reports scan, recent prompts and extraction state', async () => {
    const refresh = fakeRefresh();
    const scan = await start(refresh);
    const before = await snapshot();
    expect(before.setup).toEqual({ scan: expect.objectContaining({ phase: 'idle' }), extraction: null });

    expect((await postScan()).status).toBe(202);
    await scan.finished();
    await Bun.sleep(20);
    expect(refresh.runs).toEqual(['setup-scan']);

    const after = await snapshot();
    expect(after.setup.scan.phase).toBe('done');
    expect(after.setup.scan.recentPrompts.length).toBe(5);
    const times = after.setup.scan.recentPrompts.map((prompt: { at: string }) => prompt.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(after.setup.extraction).toEqual({
      state: 'waiting-for-agent', reason: 'setup-scan', step: null, agent: null, startedAt: null, finishedAt: null,
      error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.',
    });

    // A later scan is a new scan: it starts the extraction again, once.
    await postScan();
    await scan.finished();
    await Bun.sleep(20);
    expect(refresh.runs).toEqual(['setup-scan', 'setup-scan']);
  });

  it('while running, step follows what has landed: goals first', async () => {
    const refresh = fakeRefresh();
    await start(refresh);
    refresh.current = { state: 'running', reason: 'setup-scan', startedAt: '2026-10-10T00:00:05.000Z' };
    expect((await snapshot()).setup.extraction).toMatchObject({ state: 'running', step: 'goals', startedAt: '2026-10-10T00:00:05.000Z' });
  });
});
