import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { composeViewerSyncStatus } from '../../../../src/shared/viewer-sync-status.js';

let directory: string, db: Database, routes: WorkViewRoutes, server: Server, origin: string;
let activity: unknown[][];
const sync = composeViewerSyncStatus(null, null, null, 1000);

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-sync-'));
  const databasePath = join(directory, 'source.db');
  db = new Database(databasePath);
  db.exec('CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  activity = [];
  routes = new WorkViewRoutes({ databasePath, ledgerDir: null, humanCopy: null, reviewPath: join(directory, 'review.db'),
    setupStatePath: join(directory, 'setup.json'), getSyncStatus: () => sync,
    updateViewerActivity: (...args) => { activity.push(args); return true; } });
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  routes.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); rmSync(directory, { recursive: true, force: true });
});

it('includes sync evidence in compact and legacy views without changing content identity', async () => {
  const overview = await (await fetch(`${origin}/api/work-view/overview`)).json();
  const full = await (await fetch(`${origin}/api/work-view`)).json();
  expect(overview.sync).toEqual(sync);
  expect(full.sync).toEqual(sync);
  expect(typeof full.source.activityCheckedAt).toBe('string');
});

it('accepts only same-origin, bounded and sequenced visibility activity', async () => {
  const post = (body: unknown, source = origin) => fetch(`${origin}/api/work-view/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source }, body: JSON.stringify(body),
  });
  expect((await post({ viewerId: 'tab', visible: true, sequence: 1 })).status).toBe(204);
  expect(activity).toEqual([['tab', true, 1]]);
  expect((await post({ viewerId: 'tab', visible: true, sequence: 2 }, 'https://foreign.test')).status).toBe(403);
  expect((await post({ viewerId: 'tab', visible: true })).status).toBe(400);
  expect((await post({ viewerId: 'tab', visible: true, sequence: 1.5 })).status).toBe(400);
  expect(activity).toHaveLength(1);
});

it('publishes a sync-only event without requiring another projection read', async () => {
  const controller = new AbortController();
  try {
    const response = await fetch(`${origin}/api/work-view/events?view=overview`, { signal: controller.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
    while (!text.includes('event: work-view-overview')) text += decoder.decode((await reader.read()).value, { stream: true });
    const before = (routes as any).sourceReader.getDiagnostics().completedReads;
    routes.publishSyncStatus(sync);
    while (!text.includes('event: sync_status')) text += decoder.decode((await reader.read()).value, { stream: true });
    expect(text).toContain('"sync":');
    expect((routes as any).sourceReader.getDiagnostics().completedReads).toBe(before);
  } finally { controller.abort(); }
});
