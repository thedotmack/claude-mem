import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { contentFingerprint } from '../../../../src/services/work-view/review-store.js';
import { reduceWorkState } from '../../../../src/services/work-view/data-source.mjs';

let directory: string;
let source: Database;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;
let reviewPath: string;
let databasePath: string;
let controllers: AbortController[];
let nextId: number;

function append(fields: Record<string, unknown>) {
  source.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)')
    .run(nextId++, 'example-project', 'example-work', JSON.stringify(fields), Date.now());
}

async function start() {
  routes = new WorkViewRoutes({ databasePath, reviewPath, pollIntervalMs: 20 });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
}

async function stop() {
  controllers.forEach(controller => controller.abort());
  routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-test-'));
  databasePath = join(directory, 'source.db');
  reviewPath = join(directory, 'private-review.db');
  source = new Database(databasePath);
  source.exec('PRAGMA journal_mode=WAL');
  source.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  nextId = 1; controllers = [];
  append({ task: 'Build the local viewer', status: 'done', request_id: 'viewer-request', human_request: 'Build a local work viewer', request_complete: true, outcome: 'The local viewer is ready to use.' });
  await start();
});

afterEach(async () => {
  await stop();
  source.close();
  rmSync(directory, { recursive: true, force: true });
});

async function snapshot() { return (await fetch(`${origin}/api/work-view`)).json(); }
async function review(request: any, checked = true, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/work-view/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify({ requestId: request.id, expectedFingerprint: request.contentFingerprint, checked }),
  });
}

describe('local work view', () => {
  it('projects explicit completion and evidence without inventing presence or altering source', async () => {
    const before = source.prepare('SELECT * FROM work_state_entries').all();
    const view = await snapshot();
    expect(view.source.connected).toBe(true);
    expect(view.humanRequests).toHaveLength(1);
    expect(view.humanRequests[0].lifecycle.complete).toBe(true);
    expect(view.humanRequests[0].contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(view.humanRequests[0].review.checked).toBe(false);
    expect(view.coverage.livePresenceAvailable).toBe(false);
    expect(view.agents[0].presence.isLive).toBeNull();
    expect(view.humanRequests[0].items[0].url).toBe('/api/work-view/evidence/work-state/1');
    const evidence = await fetch(`${origin}/api/work-view/evidence/work-state/1`);
    expect(evidence.status).toBe(200);
    expect((await evidence.json()).fields).toContain('viewer-request');
    expect((await fetch(`${origin}/api/work-view/evidence/secret/1`)).status).toBe(404);
    expect(source.prepare('SELECT * FROM work_state_entries').all()).toEqual(before);
  });

  it('persists a check across restart and undoes it without writing source work', async () => {
    const request = (await snapshot()).humanRequests[0];
    const response = await review(request);
    expect(response.status).toBe(200);
    expect((await response.json()).humanRequests[0].review.checked).toBe(true);
    await stop(); await start();
    const restored = (await snapshot()).humanRequests[0];
    expect(restored.contentFingerprint).toBe(request.contentFingerprint);
    expect(restored.review.checked).toBe(true);
    expect(restored.review.actor).toBe('local-user');
    expect((await review(restored, false)).status).toBe(200);
    expect((await snapshot()).humanRequests[0].review.checked).toBe(false);
    expect(source.prepare('SELECT COUNT(*) as n FROM work_state_entries').get()).toEqual({ n: 1 });
  });

  it('rejects stale review versions and makes new work unreviewed', async () => {
    const request = (await snapshot()).humanRequests[0];
    expect((await review(request)).status).toBe(200);
    append({ task: 'Build the local viewer', progress: 'A revised result is ready for another look.' });
    const updated = (await snapshot()).humanRequests[0];
    expect(updated.contentFingerprint).not.toBe(request.contentFingerprint);
    expect(updated.review.checked).toBe(false);
    expect((await review(request)).status).toBe(409);
    expect((await review(request, false)).status).toBe(409);
    expect((await review(updated)).status).toBe(200);
  });

  it('cannot mark completed child work checked without request completion', async () => {
    append({ task: 'Build the local viewer', request_complete: false });
    const request = (await snapshot()).humanRequests[0];
    expect((await review(request)).status).toBe(409);
    expect((await snapshot()).humanRequests[0].review.checked).toBe(false);
  });

  it('rejects foreign pages, proxy requests, rebound hosts and non-JSON writes', async () => {
    const request = (await snapshot()).humanRequests[0];
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: 'http://127.0.0.1:3' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Forwarded-For': '127.0.0.1' }]) {
      expect((await review(request, true, headers)).status).toBe(403);
    }
    expect((await fetch(`${origin}/api/work-view`, { headers: { Host: 'rebound.example' } })).status).toBe(403);
    expect((await fetch(`${origin}/api/work-view`, { headers: { 'X-Forwarded-Host': 'localhost' } })).status).toBe(403);
    expect((await fetch(`${origin}/api/work-view/review`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(403);
    expect((await snapshot()).humanRequests[0].review.checked).toBe(false);
  });

  it('rejects malformed review payloads', async () => {
    for (const body of [{}, { requestId: 'x', expectedFingerprint: 'invalid', checked: true }, { requestId: 'x', expectedFingerprint: 'a'.repeat(64), checked: true, fields: { status: 'done' } }]) {
      const response = await fetch(`${origin}/api/work-view/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
  });

  it('keeps local work readable when the optional review database is damaged', async () => {
    await stop();
    writeFileSync(reviewPath, 'This is not a SQLite database.');
    await start();
    const view = await snapshot();
    expect(view.source.connected).toBe(true);
    expect(view.humanRequests).toHaveLength(1);
    expect(view.humanRequests[0].review.available).toBe(false);
    expect((await review(view.humanRequests[0])).status).toBe(503);
  });

  it('keeps an older imported write from replacing newer completion', async () => {
    source.exec('ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT');
    source.exec('ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT');
    const current = (source.prepare('SELECT created_at_epoch FROM work_state_entries WHERE id = 1').get() as { created_at_epoch: number }).created_at_epoch;
    source.prepare('INSERT INTO work_state_entries(id, project, list_name, fields, created_at_epoch, origin_device_id, origin_local_id) VALUES(2,?,?,?,?,?,?)')
      .run('example-project', 'example-work', JSON.stringify({ task: 'Build the local viewer', request_complete: false, outcome: 'Earlier unfinished work' }), current - 1000, 'other-device', '40');
    const request = (await snapshot()).humanRequests[0];
    expect(request.lifecycle.complete).toBe(true);
    expect(request.items[0].outcome.text).toBe('The local viewer is ready to use.');
  });

  it('refreshes a replicated row revised in place', async () => {
    source.exec("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT DEFAULT '1'");
    const first = (await snapshot()).humanRequests[0];
    source.prepare("UPDATE work_state_entries SET fields = ?, sync_rev = '2' WHERE id = 1").run(JSON.stringify({ task: 'Build the local viewer', request_id: 'viewer-request', human_request: 'Build a local work viewer', request_complete: false, progress: 'Reopened for another check.' }));
    const changed = (await snapshot()).humanRequests[0];
    expect(changed.contentFingerprint).not.toBe(first.contentFingerprint);
    expect(changed.lifecycle.complete).toBe(false);
  });

  it('serves a retained snapshot with unavailable-source health and refuses reviews', async () => {
    const request = (await snapshot()).humanRequests[0];
    source.close();
    rmSync(databasePath);
    const unavailable = await snapshot();
    expect(unavailable.source.connected).toBe(false);
    expect(unavailable.source.stale).toBe(true);
    expect(unavailable.humanRequests[0].id).toBe(request.id);
    expect((await review(request)).status).toBe(503);
    // afterEach may safely close an already closed handle.
  });

  it('streams genuine external source changes and releases disconnected clients', async () => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${origin}/api/work-view/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    const nextSnapshot = async (): Promise<any> => {
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.includes('event: work-view')) return JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6));
          } else {
            const part = await reader.read(); if (part.done) throw new Error('stream ended');
            buffer += decoder.decode(part.value, { stream: true });
          }
        }
      } finally { clearTimeout(timeout); }
    };
    const first = await nextSnapshot();
    expect(routes.getClientCount()).toBe(1);
    append({ task: 'Build the local viewer', progress: 'An external write arrived over the live stream.' });
    let changed = await nextSnapshot();
    while (changed.revision === first.revision) changed = await nextSnapshot();
    expect(changed.humanRequests[0].contentFingerprint).not.toBe(first.humanRequests[0].contentFingerprint);
    expect(changed.source.connected).toBe(true);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(routes.getClientCount()).toBe(0);
  });
});

describe('review content versions', () => {
  it('matches canonical device and origin-row ordering at the same timestamp', () => {
    const row = { project: 'example', list_name: 'work', created_at_epoch: 1000 };
    const state = reduceWorkState([
      { ...row, id: 30, origin_device_id: 'a-device', origin_local_id: '99', fields: { task: 'task', status: 'todo' } },
      { ...row, id: 1, fields: { task: 'task', status: 'done' } },
    ], { localDeviceId: 'z-device' });
    expect(state.lists[0].tasks[0].status).toBe('done');
    expect(state.lists[0].tasks[0].latestEntryId).toBe(1);
  });
  it('ignores transport clocks and generated copy but includes recorded result changes', () => {
    const request = { id: 'x', title: 'Request', items: [{ outcome: { text: 'Done' } }] };
    expect(contentFingerprint({ ...request, generatedAt: 1, humanCopy: { summary: 'first' } })).toBe(contentFingerprint({ ...request, generatedAt: 2, humanCopy: { summary: 'second' } }));
    expect(contentFingerprint({ ...request, items: [{ outcome: { text: 'New result' } }] })).not.toBe(contentFingerprint(request));
  });
});
