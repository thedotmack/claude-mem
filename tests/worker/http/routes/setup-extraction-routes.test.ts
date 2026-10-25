// Funnel Phase 5: a finished setup scan starts the extraction once, and the snapshot carries setup.{scan, extraction}.
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { SetupScan } from '../../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { Database } from 'bun:sqlite';
import { gunzipSync } from 'node:zlib';
import type { AutoRefreshWorker } from '../../../../src/services/work-view/auto-refresh-worker.mjs';
import { HostedIntent, type HostedIntentState } from '../../../../src/services/work-view/hosted-intent.js';

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

async function start(refresh: ReturnType<typeof fakeRefresh>, ledger: { dir: string; databasePath: string } | null = null, hostedIntent: Pick<HostedIntent, 'run' | 'state'> | null = null, homeDirectory = FIXTURE_HOME) {
  store = new SessionStore(ledger?.databasePath ?? ':memory:');
  let clock = Date.parse('2026-10-10T00:00:00.000Z');
  const setupScan = new SetupScan({
    getStore: () => store, now: () => (clock += 1000), progressIntervalMs: 0,
    scanOptions: { homeDirectory, resolveProject: () => 'fixture' },
  });
  routes = new WorkViewRoutes({
    databasePath: ledger?.databasePath ?? join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: ledger?.dir ?? null, setupScan, autoRefresh: refresh as unknown as AutoRefreshWorker, hostedIntent,
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
  it('finishes an empty-history setup without issuing credentials or calling Cloud', async () => {
    const scratch = mkdtempSync(join(import.meta.dir, '..', '..', '..', '..', '.scratch', 'test-runs', 'empty-hosted-snapshot-'));
    try {
      const databasePath = join(scratch, 'claude-mem.db'), ledgerDir = join(scratch, 'work-view');
      const intentConfigPath = join(scratch, 'intent-install.json');
      let requests = 0;
      const hosted = new HostedIntent({
        origin: () => 'https://cloud.example', credentials: () => ({ token: '', userId: '' }), intentConfigPath,
        ledgerDir, openDatabase: () => new Database(databasePath, { readonly: true }),
        appendWorkStateEntry: entry => { store.appendWorkStateEntry(entry); }, homeProject: () => 'home',
        fetch: (async () => { requests++; throw new Error('Empty setup must not contact Cloud'); }) as typeof fetch,
      });
      const refresh = fakeRefresh();
      const scan = await start(refresh, { databasePath, dir: ledgerDir }, hosted, scratch);
      expect((await postScan()).status).toBe(202);
      await scan.finished();
      const view = await snapshot();
      expect(view.setup.scan).toMatchObject({ phase: 'done', done: true, error: null });
      expect(view.setup.scan.agents.every((agent: { prompts: number }) => agent.prompts === 0)).toBe(true);
      expect(view.setup.extraction).toMatchObject({ state: 'ok', error: null });
      expect(requests).toBe(0);
      expect(existsSync(intentConfigPath)).toBe(false);
      expect(refresh.runs).toEqual([]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  it('waits for hosted extraction before done and never starts the local setup agent', async () => {
    const refresh = fakeRefresh();
    let complete!: () => void;
    let calls = 0;
    let state: HostedIntentState = { state: 'idle', reason: 'setup-scan', step: null, agent: null, error: null, startedAt: null, finishedAt: null };
    const hosted = {
      state: () => state,
      run: async () => {
        calls++;
        state = { ...state, state: 'running', step: 'goals' };
        await new Promise<void>(resolve => { complete = resolve; });
        state = { ...state, state: 'ok', step: null };
      },
    };
    const scan = await start(refresh, null, hosted);
    expect((await postScan()).status).toBe(202);
    for (let wait = 0; !complete && wait < 100; wait++) await Bun.sleep(10);
    expect(scan.state()).toMatchObject({ phase: 'uploading', done: false });
    expect((await snapshot()).setup.extraction).toMatchObject({ state: 'running' });
    // Starting while uploading joins the existing scan, it cannot pay for a second run.
    await postScan();
    expect(calls).toBe(1);
    complete();
    await scan.finished();
    expect(scan.state()).toMatchObject({ phase: 'done', done: true });
    expect((await snapshot()).setup.extraction).toMatchObject({ state: 'ok' });
    expect(refresh.runs).toEqual([]);
  });

  it('keeps the hosted reason in the existing scan error slot', async () => {
    const message = 'Hosted setup failed (HTTP 413): Input exceeds the 400000-token cost cap. No prompts were truncated.';
    const scan = await start(fakeRefresh(), null, { state: () => ({ state: 'failed', reason: 'setup-scan', step: null, agent: null, startedAt: null, finishedAt: null, error: message }), async run() { throw new Error(message); } });
    await postScan();
    await scan.finished();
    expect(scan.state()).toMatchObject({ phase: 'failed', done: true, error: message });
    expect((await snapshot()).setup.scan.error).toBe(message);
  });

  it('passes the unchecked preference through after scanning and still completes', async () => {
    let improveProduct: boolean | undefined;
    const scan = await start(fakeRefresh(), null, { state: () => ({ state: 'ok', reason: 'setup-scan', step: null, agent: null, startedAt: null, finishedAt: null, error: null }), async run(_prompts, flag) { improveProduct = flag; } });
    expect(scan.state().improveProduct).toBe(true);
    const changed = await fetch(`${origin}/api/setup/scan/preferences`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ improveProduct: false }) });
    expect(changed.status).toBe(200);
    await postScan();
    await scan.finished();
    expect(improveProduct).toBe(false);
    expect(scan.state()).toMatchObject({ phase: 'done', done: true });
  });

  it('issues anonymous credentials and lands a mocked Cloud result in the live goals, rules and setup work snapshot', async () => {
    const scratch = mkdtempSync(join(import.meta.dir, '..', '..', '..', '..', '.scratch', 'test-runs', 'hosted-snapshot-'));
    try {
      const databasePath = join(scratch, 'claude-mem.db'), ledgerDir = join(scratch, 'work-view');
      const requests: string[] = [];
      const install = { install_id: 'a'.repeat(32), intent_token: 'b'.repeat(64) };
      const hosted = new HostedIntent({
        origin: () => 'https://cloud.example', credentials: () => ({ token: '', userId: '' }),
        intentConfigPath: join(scratch, 'intent-install.json'),
        ledgerDir, openDatabase: () => new Database(databasePath, { readonly: true }),
        appendWorkStateEntry: entry => { store.appendWorkStateEntry(entry); }, homeProject: () => 'home',
        fetch: (async (url, init) => {
          requests.push(String(url));
          if (String(url).endsWith('/api/installer/intent')) return Response.json(install);
          expect(init!.headers).toMatchObject({ 'X-Intent-Install-Id': install.install_id, 'X-Intent-Token': install.intent_token });
          const input = JSON.parse(gunzipSync(init!.body as Uint8Array).toString());
          const ids = [...new Set(input.ownerPrompts.map((prompt: { sessionId: string }) => prompt.sessionId))];
          return Response.json({
            goals: { map: '# Owner map', goals: { generated_at: '2026-10-10T00:00:00Z', window_days: 30,
              source_prompt_count: input.ownerPrompts.length, human_summary: 'Ship the plan.', priorities: [{ rank: 1,
                title: 'Ship the plan', product: 'fixture', latest_at: '2026-10-10 00:00', times_asked: 2,
                evidence: [{ at: '2026-10-10 00:00', quote: 'ship' }, { at: '2026-10-10 00:00', quote: 'plan' }] }], open_asks: [] } },
            rules: [{ preference: 'Test the change.', kind: 'directive', supportCount: 2, quotes: [{ at: '2026-10-10 00:00', quote: 'test' }] }],
            groups: { groups: ids.map(id => ({ title: `Request ${id}`, product: 'fixture', conversations: [id], links: [] })), ignored: [] },
            cost_usd: 0.02, model: 'mock-model', dropped_quotes: 0,
          });
        }) as typeof fetch,
      });
      const scan = await start(fakeRefresh(), { databasePath, dir: ledgerDir }, hosted);
      await postScan();
      await scan.finished();
      expect(requests).toEqual(['https://cloud.example/api/installer/intent', 'https://cloud.example/api/pro/intent']);
      const view = await snapshot();
      expect(view.setup.scan).toMatchObject({ phase: 'done', done: true });
      expect(view.setup.extraction.state).toBe('ok');
      expect(view.goals.priorities[0].title).toBe('Ship the plan');
      expect(view.rules[0].then).toBe('Test the change.');
      expect(view.setup.work.length).toBeGreaterThan(0);
      expect(view.setup.work[0].title).toStartWith('Request ');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
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
