import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { __resetTelemetryForTests } from '../../../../src/services/telemetry/telemetry.js';
import { postHogCaptureCalls } from '../../../preload';

// The viewer reports which page it opened on and which page it switched to; the worker counts that through its
// own PostHog client (tests/preload.ts mocks posthog-node), so the page loads no analytics SDK and the usual
// consent gate and property whitelist apply.
const ENV_KEYS = ['CLAUDE_MEM_TELEMETRY', 'CLAUDE_MEM_TELEMETRY_DEBUG', 'DO_NOT_TRACK'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let directory: string;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
  delete process.env.DO_NOT_TRACK;
  __resetTelemetryForTests();
  postHogCaptureCalls.length = 0;

  directory = mkdtempSync(join(tmpdir(), 'work-view-usage-test-'));
  const databasePath = join(directory, 'source.db');
  const source = new Database(databasePath);
  source.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  source.close();
  routes = new WorkViewRoutes({ databasePath, reviewPath: join(directory, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir: null, setupStatePath: join(directory, 'setup-state.json') });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(directory, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetTelemetryForTests();
  postHogCaptureCalls.length = 0;
});

const report = (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin }) =>
  fetch(`${origin}/api/work-view/usage`, { method: 'POST', headers, body: JSON.stringify(body) });
const captured = () => postHogCaptureCalls.map(call => ({ event: call.event, properties: call.properties as Record<string, unknown> }));

describe('My Work usage telemetry', () => {
  it('counts the viewer opening on a page: profile-less, keyed to the install id, carrying only the page id', async () => {
    expect((await report({ event: 'opened', view: 'work' })).status).toBe(204);
    expect(captured()).toHaveLength(1);
    const [opened] = captured();
    expect(opened.event).toBe('work_view_opened');
    expect(opened.properties.view).toBe('work');
    expect(opened.properties.previous_view).toBeUndefined();
    expect(opened.properties.$process_person_profile).toBe(false);
    expect(typeof postHogCaptureCalls[0].distinctId).toBe('string');
  });

  it('counts a switch together with the page it left', async () => {
    expect((await report({ event: 'switched', view: 'past-focus', previousView: 'work' })).status).toBe(204);
    expect(captured()).toEqual([
      expect.objectContaining({ event: 'work_view_switched', properties: expect.objectContaining({ view: 'past-focus', previous_view: 'work' }) }),
    ]);
  });

  it('refuses another origin, an unknown page, a switch without the page it left, and any extra field', async () => {
    expect((await report({ event: 'opened', view: 'work' }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await report({ event: 'opened', view: 'timeline' })).status).toBe(400);
    expect((await report({ event: 'opened', view: 'goals' })).status).toBe(400); // My Goals was retired for focus areas (#5131)
    expect((await report({ event: 'switched', view: 'suggested' })).status).toBe(400);
    expect((await report({ event: 'opened', view: 'work', title: 'Build the local viewer' })).status).toBe(400);
    expect(captured()).toHaveLength(0);
  });

  it('sends nothing with telemetry off, and still answers the page', async () => {
    process.env.CLAUDE_MEM_TELEMETRY = '0';
    __resetTelemetryForTests();
    expect((await report({ event: 'opened', view: 'rules' })).status).toBe(204);
    expect(captured()).toHaveLength(0);
  });
});
