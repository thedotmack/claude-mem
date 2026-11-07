// Funnel Phase 8: runBrowserSetup's checkout loop against the real setup endpoints. A repeat Continue while checkout
// is open opens it again; a failed checkout is reported and the next Continue runs a new one.
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorkViewRoutes } from '../../src/services/worker/http/routes/WorkViewRoutes.js';
import { runBrowserSetup } from '../../src/npx-cli/install/browser-setup.js';

const FIXTURE_HOME = join(import.meta.dir, '..', 'fixtures', 'prompt-import', 'home');
const scratchRoot = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const dir = mkdtempSync(join(scratchRoot, 'browser-setup-checkout-'));
const statePath = join(dir, 'setup-state.json');

let server: Server;
let routes: WorkViewRoutes;
let origin: string;

afterEach(async () => {
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(statePath, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function start() {
  routes = new WorkViewRoutes({
    databasePath: join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: null, setupScan: null, setupStatePath: statePath, settingsPath: join(dir, 'settings.json'),
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
}

const state = async () => (await fetch(`${origin}/api/setup/state`)).json() as Promise<any>;
const page = (path: string) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
async function until(check: (current: any) => boolean): Promise<any> {
  for (;;) { const current = await state(); if (check(current)) return current; await Bun.sleep(5); }
}

describe('installer checkout loop', () => {
  it('opens checkout per request, reopens on a repeat while open, reports failed, then paid', async () => {
    await start();
    const events: string[] = [];
    const runs: Array<(paid: boolean) => void> = [];
    const setup = runBrowserSetup({
      workerBaseUrl: origin, openBrowser: () => {}, log: { info: () => {}, warn: () => {} }, pollIntervalMs: 5,
      applyChoice: async () => 'go-awaiting-checkout',
      checkout: {
        run: () => { events.push('run'); return new Promise<boolean>(resolve => runs.push(resolve)); },
        reopen: () => { events.push('reopen'); },
      },
    });
    await until(current => current.installer?.stage === 'waiting-for-choice');
    await fetch(`${origin}/api/setup/choice`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ branch: 'go', memoryBilling: 'hosted' }) });
    await until(current => current.installer?.stage === 'go-awaiting-checkout');

    await page('/api/setup/checkout');
    await until(current => current.checkout?.state === 'waiting');
    await page('/api/setup/checkout');
    await until(() => events.includes('reopen'));
    await until(current => current.checkout?.state === 'waiting' && current.checkout.requests === 2);
    runs.shift()!(false);
    expect((await until(current => current.checkout?.state === 'failed')).checkout.error).toMatch(/Continue to open it again/);
    expect((await page('/api/setup/complete')).status).toBe(409);

    await page('/api/setup/checkout');
    await until(() => runs.length === 1);
    runs.shift()!(true);
    await until(current => current.checkout?.state === 'paid');
    expect((await page('/api/setup/complete')).status).toBe(200);
    const outcome = await setup;
    expect(outcome).toMatchObject({ stage: 'go-awaiting-checkout', checkoutPaid: true });
    expect(events).toEqual(['run', 'reopen', 'run']);
  });
});
