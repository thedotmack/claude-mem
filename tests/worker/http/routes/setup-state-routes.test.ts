import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAutoRefresh, WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', '..', 'fixtures', 'prompt-import', 'home');
// Project-local scratch (gitignored), never the system temp folder.
const scratchRoot = join(import.meta.dir, '..', '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const dir = mkdtempSync(join(scratchRoot, 'setup-state-routes-'));
const statePath = join(dir, 'setup-state.json');
const sessionPath = join(dir, 'setup-session.json');
const settingsPath = join(dir, 'settings.json');

let server: Server;
let routes: WorkViewRoutes;
let origin: string;

async function start(autoRefresh: unknown = null) {
  routes = new WorkViewRoutes({
    databasePath: join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: null, setupScan: null, setupStatePath: statePath, settingsPath, autoRefresh: autoRefresh as never,
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
  rmSync(statePath, { force: true });
  rmSync(sessionPath, { force: true });
  rmSync(settingsPath, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const state = async () => (await fetch(`${origin}/api/setup/state`)).json();
function post(path: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin }) {
  return fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('setup state endpoints', () => {
  it('start pending on a machine that never finished setup, with nothing pre-selected', async () => {
    await start();
    expect(await state()).toEqual({ status: 'pending', choice: null, installer: null, checkout: null, tools: null, completedAt: null, alreadyPro: false, history: { projects: 0, sessions: 0, observations: 0 }, historyImport: null, backgroundWorkRunning: [] });
    expect(existsSync(statePath)).toBe(false);
  });

  it('pauses local auto refresh only for active setup, preserving non-GUI installs and completed setup', async () => {
    await start();
    let scanning = false;
    const refresh = defaultAutoRefresh(dir, settingsPath, statePath, () => scanning);
    const enabled = () => (refresh as unknown as { enabled: () => boolean }).enabled();
    expect(enabled()).toBe(true); // Non-GUI installs do not write a funnel marker.
    scanning = true;
    expect(enabled()).toBe(false);
    scanning = false;
    writeFileSync(sessionPath, JSON.stringify({ pid: process.pid }));
    await post('/api/setup/installer', { stage: 'waiting-for-choice' });
    expect(enabled()).toBe(false);
    await post('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await post('/api/setup/installer', { stage: 'home-ready' });
    await post('/api/setup/complete', {});
    expect(enabled()).toBe(true);
    refresh.close();
  });

  it('resumes local refresh after an interrupted installer without discarding saved setup progress', async () => {
    const saved = { status: 'pending', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' } };
    writeFileSync(statePath, JSON.stringify(saved));
    writeFileSync(sessionPath, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    await start();
    const refresh = defaultAutoRefresh(dir, settingsPath, statePath);
    try {
      expect((refresh as unknown as { enabled: () => boolean }).enabled()).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(saved);
    } finally {
      refresh.close();
    }
  });

  it('resumes after normal session removal and surfaces a corrupt session marker', async () => {
    await start();
    const refresh = defaultAutoRefresh(dir, settingsPath, statePath);
    const enabled = () => (refresh as unknown as { enabled: () => boolean }).enabled();
    try {
      writeFileSync(sessionPath, JSON.stringify({ pid: process.pid }));
      expect(enabled()).toBe(false);
      rmSync(sessionPath);
      expect(enabled()).toBe(true);
      writeFileSync(sessionPath, '{broken');
      expect(enabled).toThrow();
    } finally {
      refresh.close();
    }
  });

  it('keeps local work paused until an active scan ends after the installer exits', async () => {
    await start();
    const testRoutes = routes as unknown as { setupScan: unknown; setupIsActive: () => boolean };
    let phase = 'reading';
    testRoutes.setupScan = { state: () => ({ phase }) };
    for (phase of ['reading', 'checking', 'saving', 'uploading']) expect(testRoutes.setupIsActive()).toBe(true);
    for (phase of ['idle', 'done', 'failed']) expect(testRoutes.setupIsActive()).toBe(false);
  });

  it('report a live extraction run as background work (the installer holds any restart for it), not one a restart cut off', async () => {
    let status: Record<string, unknown> | null = { state: 'running', pid: process.pid };
    await start({ status: () => status, start() {}, close() {}, async runNow() { return 'idle'; } });
    expect((await state()).backgroundWorkRunning).toEqual(['extraction']);
    // A 'running' record left by a worker process that is gone.
    status = { state: 'running', pid: 2 ** 22 + 12345 };
    expect((await state()).backgroundWorkRunning).toEqual([]);
    status = { state: 'ok', pid: process.pid };
    expect((await state()).backgroundWorkRunning).toEqual([]);
  });

  it('report an existing CMEM Pro configuration so On The Go is pre-selected', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'token', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.example',
    } }));
    await start();
    expect((await state()).alreadyPro).toBe(true);
  });

  it('accept only well-formed choices from the viewer page', async () => {
    await start();
    expect((await post('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/api/setup/choice', { branch: 'away', memoryBilling: 'hosted' })).status).toBe(400);
    // On The Go is always CMEM Pro (gap G1).
    expect((await post('/api/setup/choice', { branch: 'go', memoryBilling: 'existing' })).status).toBe(400);
    expect((await state()).choice).toBeNull();
  });

  it('record the choice, lock it once the installer applied it, and finish setup once', async () => {
    await start();
    expect((await post('/api/setup/complete', {})).status).toBe(409);

    expect((await post('/api/setup/installer', { stage: 'waiting-for-choice' })).status).toBe(200);
    const chosen = await post('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' });
    expect(chosen.status).toBe(200);
    expect((await chosen.json()).choice).toMatchObject({ branch: 'go', memoryBilling: 'hosted' });
    // Before the installer acts, the person can still change their mind.
    expect((await post('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' })).status).toBe(200);

    expect((await post('/api/setup/installer', { stage: 'home-ready' })).status).toBe(200);
    expect((await post('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' })).status).toBe(409);
    expect((await post('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' })).status).toBe(200);

    const completed = await post('/api/setup/complete', {});
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: 'complete', choice: { branch: 'home' }, installer: { stage: 'home-ready' } });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('complete');
    expect((await post('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' })).status).toBe(409);
  });

  it('clear an interrupted run\'s choice when a new installer starts waiting', async () => {
    await start();
    await post('/api/setup/installer', { stage: 'waiting-for-choice' });
    await post('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' });
    await post('/api/setup/installer', { stage: 'failed', error: 'cmem.ai unreachable' });
    expect((await state()).installer).toMatchObject({ stage: 'failed', error: 'cmem.ai unreachable' });
    await post('/api/setup/installer', { stage: 'waiting-for-choice' });
    expect((await state()).choice).toBeNull();
  });

  it('push every change on the work view event stream', async () => {
    await start();
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/work-view/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await post('/api/setup/installer', { stage: 'waiting-for-choice' });
    const decoder = new TextDecoder();
    let buffer = '';
    const setupStates = () => buffer.split('\n\n').filter(block => block.startsWith('event: setup-state\n')).map(block => JSON.parse(block.split('\ndata: ')[1]));
    while (!setupStates().some(view => view.installer?.stage === 'waiting-for-choice')) buffer += decoder.decode((await reader.read()).value, { stream: true });
    controller.abort();
    expect(setupStates()[0].installer).toBeNull();
    expect(setupStates().at(-1).installer.stage).toBe('waiting-for-choice');
  });

  it('send the current setup state on every new event stream, so a reconnect sees a checkout paid while it was away', async () => {
    await start();
    await post('/api/setup/installer', { stage: 'go-awaiting-checkout', checkout: 'paid' });
    const controller = new AbortController();
    const reader = (await fetch(`${origin}/api/work-view/events`, { signal: controller.signal })).body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('event: setup-state\n') || !buffer.slice(buffer.indexOf('event: setup-state\n')).includes('\n\n')) buffer += decoder.decode((await reader.read()).value, { stream: true });
    controller.abort();
    const block = buffer.slice(buffer.indexOf('event: setup-state\n')).split('\n\n')[0];
    expect(JSON.parse(block.split('\ndata: ')[1]).checkout.state).toBe('paid');
  });

  it('import history only on On The Go, and only with a history import on the worker', async () => {
    await start();
    expect((await post('/api/setup/import', {})).status).toBe(503);
  });
});
