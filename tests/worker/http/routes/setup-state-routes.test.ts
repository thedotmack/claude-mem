import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', '..', 'fixtures', 'prompt-import', 'home');
// Project-local scratch (gitignored), never the system temp folder.
const scratchRoot = join(import.meta.dir, '..', '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const dir = mkdtempSync(join(scratchRoot, 'setup-state-routes-'));
const statePath = join(dir, 'setup-state.json');
const settingsPath = join(dir, 'settings.json');

let server: Server;
let routes: WorkViewRoutes;
let origin: string;

async function start() {
  routes = new WorkViewRoutes({
    databasePath: join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: null, setupScan: null, setupStatePath: statePath, settingsPath,
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
    expect(await state()).toEqual({ status: 'pending', choice: null, installer: null, checkout: null, completedAt: null, alreadyPro: false });
    expect(existsSync(statePath)).toBe(false);
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
    while (!buffer.includes('event: setup-state\n')) buffer += decoder.decode((await reader.read()).value, { stream: true });
    controller.abort();
    const block = buffer.slice(buffer.indexOf('event: setup-state\n')).split('\n\n')[0];
    expect(JSON.parse(block.split('\ndata: ')[1]).installer.stage).toBe('waiting-for-choice');
  });
});
