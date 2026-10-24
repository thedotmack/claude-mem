// Funnel Phase 5: a finished setup scan starts the extraction once, and the snapshot carries setup.{scan, extraction}.
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function start(refresh: ReturnType<typeof fakeRefresh>, ledger: { dir: string; databasePath: string } | null = null) {
  store = new SessionStore(ledger?.databasePath ?? ':memory:');
  let clock = Date.parse('2026-10-10T00:00:00.000Z');
  const setupScan = new SetupScan({
    getStore: () => store, now: () => (clock += 1000), progressIntervalMs: 0,
    scanOptions: { homeDirectory: FIXTURE_HOME, resolveProject: () => 'fixture' },
  });
  routes = new WorkViewRoutes({
    databasePath: ledger?.databasePath ?? join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: ledger?.dir ?? null, setupScan, autoRefresh: refresh as unknown as AutoRefreshWorker,
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
    expect(before.setup).toEqual({ scan: expect.objectContaining({ phase: 'idle' }), work: null, extraction: null });

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

  it('work comes from the request groups, newest prompt first, with a percent only from a review with evidence', async () => {
    const scratch = mkdtempSync(join(import.meta.dir, '..', '..', '..', '..', '.scratch', 'test-runs', 'setup-work-'));
    try {
      const dir = join(scratch, 'work-view');
      mkdirSync(join(dir, 'progress'), { recursive: true });
      const refresh = fakeRefresh();
      await start(refresh, { dir, databasePath: join(scratch, 'claude-mem.db') });
      const prompt = (platform: string, session: string, text: string, at: string) => {
        const id = store.createSDKSession(session, 'alpha', text, undefined, platform);
        store.saveUserPrompt(session, 1, text, id, undefined, undefined, Date.parse(at));
      };
      prompt('claude', 's-old', 'build the old thing', '2026-10-01T10:00:00.000Z');
      prompt('codex', 's-new', 'build the new thing', '2026-10-09T10:00:00.000Z');
      expect((await snapshot()).setup.work).toBeNull();

      const key = (platform: string, session: string) => JSON.stringify(['conversation', platform, session]);
      writeFileSync(join(dir, 'request-groups.json'), JSON.stringify({
        version: 1, updatedAt: null, ignored: {},
        conversations: { [key('claude', 's-old')]: 'g_000000000001', [key('codex', 's-new')]: 'g_000000000002' },
        groups: { g_000000000001: { title: 'Old thing', anchor: key('claude', 's-old'), links: [] }, g_000000000002: { title: 'New thing', anchor: key('codex', 's-new'), links: [] } },
      }));
      writeFileSync(join(dir, 'progress', 'g_000000000001.json'), JSON.stringify({ groupId: 'g_000000000001', state: 'unknown', percent: 0, summary: '', checkedAt: '2026-10-09T00:00:00.000Z' }));
      writeFileSync(join(dir, 'progress', 'g_000000000002.json'), JSON.stringify({ groupId: 'g_000000000002', state: 'in-progress', percent: 35, summary: '', checkedAt: '2026-10-09T00:00:00.000Z' }));
      expect((await snapshot()).setup.work).toEqual([
        { groupId: 'g_000000000002', title: 'New thing', platform: 'codex', lastActiveAt: '2026-10-09T10:00:00.000Z', progressPercent: 35 },
        { groupId: 'g_000000000001', title: 'Old thing', platform: 'claude', lastActiveAt: '2026-10-01T10:00:00.000Z', progressPercent: null },
      ]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
