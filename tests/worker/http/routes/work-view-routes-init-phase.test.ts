import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { InitPhaseTracker } from '../../../../src/services/server/init-phase.js';

// The worker builds these routes before dbManager.initialize() opens its read-write connection. A read-only
// handle taken on claude-mem.db in between keeps SQLite from resetting the WAL on Windows, and the first
// read-write statement fails with SQLITE_IOERR_TRUNCATE (#5127). So every read and the automatic refresh
// wait for the db_ready phase.

let directory: string;
let databasePath: string;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let initPhase: InitPhaseTracker;
let refreshStarts: number;

const fakeAutoRefresh = () => ({ start() { refreshStarts++; }, close() {}, status: () => null });

async function start() {
  routes = new WorkViewRoutes({
    databasePath, reviewPath: join(directory, 'reviews.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir: null,
    setupStatePath: join(directory, 'setup-state.json'), autoRefresh: fakeAutoRefresh() as never, initPhase,
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-init-phase-'));
  databasePath = join(directory, 'source.db');
  const source = new Database(databasePath);
  source.exec('PRAGMA journal_mode=WAL');
  source.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  source.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)')
    .run(1, 'example-project', 'example-work', JSON.stringify({ task: 'Build the local viewer', status: 'done', request_id: 'viewer-request', human_request: 'Build a local work viewer' }), Date.now());
  source.close();
  initPhase = new InitPhaseTracker();
  refreshStarts = 0;
});

afterEach(async () => {
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(directory, { recursive: true, force: true });
});

async function snapshot() { return (await fetch(`${origin}/api/work-view`)).json(); }

describe('WorkViewRoutes before the worker database is ready', () => {
  it('holds reads and the automatic refresh until db_ready, then serves the database', async () => {
    await start();
    expect(refreshStarts).toBe(0);
    const starting = await snapshot();
    expect(starting.source.connected).toBe(false);
    expect(starting.source.error).toBe('Local work-state database is starting.');
    expect(starting.humanRequests).toEqual([]);
    expect((await fetch(`${origin}/api/work-view/evidence/conversation/1`)).status).toBe(503);

    initPhase.setInitPhase('db_ready');
    expect(refreshStarts).toBe(1);
    const ready = await snapshot();
    expect(ready.source.connected).toBe(true);
    expect(ready.humanRequests).toHaveLength(1);
    expect(ready.humanRequests[0].id).toContain('viewer-request');
  });

  it('pushes the first real snapshot to a stream opened while the database was starting', async () => {
    await start();
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/work-view/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const workViewFrames = () => [...received.matchAll(/^event: work-view\ndata: (.*)$/gm)].map(match => JSON.parse(match[1]));
    const nextWorkViewFrame = async (index: number) => {
      while (workViewFrames().length <= index) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream ended early');
        received += decoder.decode(value, { stream: true });
      }
      return workViewFrames()[index];
    };
    const starting = await nextWorkViewFrame(0);
    expect(starting.source.connected).toBe(false);
    expect(starting.source.error).toBe('Local work-state database is starting.');
    initPhase.setInitPhase('db_ready');
    const ready = await nextWorkViewFrame(1);
    expect(ready.source.connected).toBe(true);
    expect(ready.humanRequests[0].id).toContain('viewer-request');
    controller.abort();
  });

  it('reads at once when the worker is already past db_ready', async () => {
    initPhase.setInitPhase('ready');
    await start();
    expect(refreshStarts).toBe(1);
    expect((await snapshot()).source.connected).toBe(true);
  });
});
