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
  it('opens the selected standalone checkout after one choice request, even if submitted twice', async () => {
    await start();
    let opens = 0;
    const setup = runBrowserSetup({
      workerBaseUrl: origin, openBrowser: () => {}, log: { info: () => {}, warn: () => {} }, pollIntervalMs: 5,
      applyChoice: async choice => {
        expect(choice.cloudSyncOffer).toBe('cloud_sync_annual');
        return 'go-awaiting-checkout';
      },
      checkout: { run: async () => { opens++; return true; }, reopen: () => { throw new Error('Unexpected reopen'); } },
    });
    await until(current => current.installer?.stage === 'waiting-for-choice');
    const confirm = () => fetch(`${origin}/api/setup/choice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ branch: 'go', memoryBilling: 'existing', cloudSyncOffer: 'cloud_sync_annual', openCheckout: true }),
    });
    expect((await Promise.all([confirm(), confirm()])).map(response => response.status)).toEqual([200, 200]);
    expect((await until(current => current.checkout?.state === 'paid')).checkout.requests).toBe(1);
    expect((await page('/api/setup/complete')).status).toBe(200);
    expect((await setup).checkoutPaid).toBe(true);
    expect(opens).toBe(1);
  });

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

  it('puts the pairing\'s code on the setup page while checkout waits, keeps it across a reopen, and clears it once paid or failed', async () => {
    await start();
    // Still live through the test: a reopen after a code's expiry drops it (the next test).
    const first = { userCode: 'K7QM-4XPT', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    const fresh = { userCode: 'CCCC-DDDD', expiresAt: null };
    const runs: Array<(paid: boolean) => void> = [];
    let code = first;
    const setup = runBrowserSetup({
      workerBaseUrl: origin, openBrowser: () => {}, log: { info: () => {}, warn: () => {} }, pollIntervalMs: 5,
      applyChoice: async () => 'go-awaiting-checkout',
      checkout: {
        run: async (showCode) => { await showCode(code); return new Promise<boolean>(resolve => runs.push(resolve)); },
        reopen: () => {},
      },
    });
    const deviceCode = async () => {
      const response = await fetch(`${origin}/api/setup/checkout/device-code`);
      return response.ok ? response.json() : response.status;
    };
    await until(current => current.installer?.stage === 'waiting-for-choice');
    await fetch(`${origin}/api/setup/choice`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ branch: 'go', memoryBilling: 'existing', openCheckout: true, cloudSyncOffer: 'cloud_sync_monthly' }) });

    await until(current => current.checkout?.state === 'waiting' && current.checkout.deviceCodeWaiting === true);
    expect(await deviceCode()).toEqual(first);
    // A repeat Continue reopens the same pairing: its waiting report still carries that code.
    await page('/api/setup/checkout');
    await until(current => current.checkout?.state === 'waiting' && current.checkout.requests === 2 && current.checkout.deviceCodeWaiting === true);
    expect(await deviceCode()).toEqual(first);
    await until(() => runs.length === 1);
    runs.shift()!(false);
    const failed = await until(current => current.checkout?.state === 'failed');
    expect(failed.checkout.deviceCodeWaiting).toBeUndefined();
    expect(await deviceCode()).toBe(404);

    // The next ask's run waits on a new pairing: the page gets that one's code, never the old one.
    code = fresh;
    await page('/api/setup/checkout');
    await until(current => current.checkout?.state === 'waiting' && current.checkout.deviceCodeWaiting === true);
    expect(await deviceCode()).toEqual(fresh);
    await until(() => runs.length === 1);
    runs.shift()!(true);
    const paid = await until(current => current.checkout?.state === 'paid');
    expect(paid.checkout.deviceCodeWaiting).toBeUndefined();
    expect(await deviceCode()).toBe(404);
    expect((await page('/api/setup/complete')).status).toBe(200);
    expect((await setup).checkoutPaid).toBe(true);
  });

  it('stops showing a code once a reopen finds it expired and no fresh pairing started', async () => {
    await start();
    const expired = { userCode: 'K7QM-4XPT', expiresAt: new Date(Date.now() - 1_000).toISOString() };
    let settle!: (paid: boolean) => void;
    const setup = runBrowserSetup({
      workerBaseUrl: origin, openBrowser: () => {}, log: { info: () => {}, warn: () => {} }, pollIntervalMs: 5,
      applyChoice: async () => 'go-awaiting-checkout',
      checkout: {
        run: async (showCode) => { await showCode(expired); return new Promise<boolean>(resolve => { settle = resolve; }); },
        // Like createPairingCheckout when cmem.ai cannot start a fresh pairing: nothing new is shown.
        reopen: () => {},
      },
    });
    const deviceCodeStatus = async () => (await fetch(`${origin}/api/setup/checkout/device-code`)).status;
    await until(current => current.installer?.stage === 'waiting-for-choice');
    await fetch(`${origin}/api/setup/choice`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ branch: 'go', memoryBilling: 'existing', openCheckout: true, cloudSyncOffer: 'cloud_sync_monthly' }) });
    await until(current => current.checkout?.state === 'waiting' && current.checkout.deviceCodeWaiting === true);
    expect(await deviceCodeStatus()).toBe(200);

    await page('/api/setup/checkout');
    const waiting = await until(current => current.checkout?.state === 'waiting' && current.checkout.requests === 2);
    expect(waiting.checkout.deviceCodeWaiting).toBeUndefined();
    expect(await deviceCodeStatus()).toBe(404);
    settle(true);
    await until(current => current.checkout?.state === 'paid');
    expect((await page('/api/setup/complete')).status).toBe(200);
    expect((await setup).checkoutPaid).toBe(true);
  });
});
