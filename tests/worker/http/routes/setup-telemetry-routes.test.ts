import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { createSetupTelemetry } from '../../../../src/services/setup/telemetry.js';
import { readSetupTelemetryContext, startSetupSession } from '../../../../src/shared/setup-state.js';
import type { SetupEvent } from '../../../../src/shared/setup-funnel.js';

const root = join(import.meta.dir, '..', '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, 'setup-telemetry-http-'));
const statePath = join(dir, 'setup-state.json');
let server: Server;
let routes: WorkViewRoutes;
let origin: string;
let sent: SetupEvent[];

async function start() {
  sent = [];
  startSetupSession(statePath, true);
  routes = new WorkViewRoutes({
    databasePath: join(dir, 'empty.db'), reviewPath: ':memory:', settingsPath: join(dir, 'settings.json'),
    ledgerDir: null, setupScan: null, humanCopy: null, autoRefresh: null, setupStatePath: statePath,
    setupTelemetry: createSetupTelemetry(statePath, { consent: () => true, capture: event => { sent.push(event); } }),
  });
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  origin = `http://127.0.0.1:${address.port}`;
}
const post = (path: string, body: unknown, requestOrigin = origin) => fetch(`${origin}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin }, body: JSON.stringify(body),
});
function event(name: SetupEvent['event'], extra: Partial<SetupEvent> = {}): SetupEvent {
  return { event: name, event_id: randomUUID(), ...readSetupTelemetryContext(statePath)!, setup_funnel_version: 1,
    visit_id: randomUUID(), step: 'workspace', branch: 'home', branch_confirmed: true, occurred_at: Date.now(), ...extra };
}
afterEach(async () => {
  routes.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(statePath, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('local setup telemetry HTTP boundary', () => {
  it('refuses foreign origins and never exposes an ingestion key or user data', async () => {
    await start();
    expect((await fetch(`${origin}/api/setup/telemetry`, { headers: { Origin: 'https://other.example' } })).status).toBe(403);
    const response = await fetch(`${origin}/api/setup/telemetry`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ context: readSetupTelemetryContext(statePath) });
    expect((await post('/api/setup/telemetry', event('setup_step_viewed'), 'https://other.example')).status).toBe(403);
    expect((await post('/api/setup/telemetry', { ...event('setup_step_viewed'), prompt: 'private' })).status).toBe(204);
    expect(sent).toHaveLength(0);
    expect((await post('/api/setup/telemetry', event('setup_step_viewed'))).status).toBe(204);
    expect(sent).toHaveLength(1);
  });
  it('emits completion only after the real setup write succeeds, including a safe malformed-telemetry fallback', async () => {
    await start();
    const visit = randomUUID();
    const completion = [event('setup_step_transitioned', { visit_id: visit, to_step: 'complete', direction: 'forward' }), event('setup_completed', { visit_id: visit })];
    await post('/api/setup/telemetry', completion[1]);
    expect(sent).toHaveLength(0);
    expect((await post('/api/setup/complete', { tools: ['claude-code'], telemetry: completion })).status).toBe(409);
    expect(sent).toHaveLength(0);
    await post('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await post('/api/setup/installer', { stage: 'home-ready' });
    expect((await post('/api/setup/complete', { tools: ['claude-code'], telemetry: completion })).status).toBe(200);
    expect(sent.map(item => item.event)).toEqual(['setup_step_transitioned', 'setup_completed']);
    expect((await post('/api/setup/complete', { tools: ['claude-code'], telemetry: { prompt: 'private' } })).status).toBe(200);
    expect(sent).toHaveLength(2);
  });
});
