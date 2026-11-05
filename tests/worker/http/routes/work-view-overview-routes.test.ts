import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { emitContextInvalidation } from '../../../../src/shared/context-invalidation.js';
import { holdEnrichedOverview } from './work-view-test-utils.js';

let dir: string, origin: string, writer: Database, routes: WorkViewRoutes, server: Server;
let controllers: AbortController[], nextId: number;

function append(requestId = 'request-a', title = 'Build the viewer', outcome = 'The result is available.') {
  writer.prepare('INSERT INTO work_state_entries VALUES(?,?,?,?,?)').run(nextId++, 'project', 'work', JSON.stringify({
    task: title, request_id: requestId, human_request: title, status: 'done', request_complete: true,
    outcome,
  }), Date.now() + nextId);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'work-overview-'));
  writer = new Database(join(dir, 'source.db'));
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('CREATE TABLE work_state_entries(id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  nextId = 1; controllers = []; append();
  routes = new WorkViewRoutes({ databasePath: join(dir, 'source.db'), ledgerDir: null, humanCopy: null,
    reviewPath: join(dir, 'review.db'), pollIntervalMs: 60_000, setupStatePath: join(dir, 'setup.json') });
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  controllers.forEach(controller => controller.abort()); routes.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  writer.close(); rmSync(dir, { recursive: true, force: true });
});

const overview = async () => (await fetch(`${origin}/api/work-view/overview`)).json();

async function firstOverviewEvent() {
  const controller = new AbortController(); controllers.push(controller);
  const response = await fetch(`${origin}/api/work-view/events?view=overview`, { signal: controller.signal });
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '', consumed = 0;
  return {
    response,
    async read() {
      for (;;) {
        const start = text.indexOf('event: work-view-overview\n', consumed);
        const end = start < 0 ? -1 : text.indexOf('\n\n', start);
        if (end >= 0) {
          consumed = end + 2;
          const frame = text.slice(start, end);
          return { value: JSON.parse(frame.split('\ndata: ')[1]), text };
        }
        const part = await reader.read(); if (part.done) throw new Error('Stream ended before overview');
        text += decoder.decode(part.value, { stream: true });
      }
    },
    stop() { controller.abort(); },
  };
}

describe('work view overview and detail', () => {
  it('returns compact cards and full detail with authoritative fingerprints; legacy API remains full', async () => {
    const response = await fetch(`${origin}/api/work-view/overview`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const current = await response.json();
    expect(current.version).toBe(1);
    const card = current.model.requests[0];
    expect(card.detailLoaded).toBe(false);
    const detailResponse = await fetch(`${origin}/api/work-view/requests/${encodeURIComponent(card.id)}?fingerprint=${card.contentFingerprint}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.request.detailLoaded).toBe(true);
    expect(detail.request.contentFingerprint).toBe(card.contentFingerprint);
    expect(detail.request.prompts.length).toBeGreaterThan(0);
    // The drawer sends the card's revision and refuses a detail that answers with another one.
    expect(detail.request.detailRevision).toBe(card.detailRevision);
    expect((await fetch(`${origin}/api/work-view/requests/${encodeURIComponent(card.id)}?fingerprint=${card.detailRevision}`)).status).toBe(200);
    const legacy = await (await fetch(`${origin}/api/work-view`)).json();
    expect(legacy.humanRequests[0].contentFingerprint).toBe(card.contentFingerprint);
    expect(legacy.humanRequests[0].items.length).toBeGreaterThan(0);
  });

  it('refuses stale, missing and malformed detail requests instead of showing mismatched evidence', async () => {
    const current = await overview(); const card = current.model.requests[0];
    append('request-a', 'Build the viewer', 'An updated recorded result');
    const changed = await fetch(`${origin}/api/work-view/requests/${encodeURIComponent(card.id)}?fingerprint=${card.contentFingerprint}`);
    expect(changed.status).toBe(409);
    expect((await changed.json()).overview.model.requests[0].contentFingerprint).not.toBe(card.contentFingerprint);
    expect((await fetch(`${origin}/api/work-view/requests/missing`)).status).toBe(404);
    expect((await fetch(`${origin}/api/work-view/requests/${encodeURIComponent(card.id)}?fingerprint[bad]=1`)).status).toBe(400);
    writer.exec('DELETE FROM work_state_entries');
    expect((await fetch(`${origin}/api/work-view/requests/${encodeURIComponent(card.id)}`)).status).toBe(404);
  });

  it('shares one concurrent bootstrap for four tabs and sends no full snapshot to compact clients', async () => {
    const reader = (routes as any).sourceReader; const read = reader.read.bind(reader);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    reader.read = (...args: any[]) => { reads++; return read(...args).then(async (value: unknown) => { await gate; return value; }); };
    const http = Promise.all(Array.from({ length: 4 }, () => overview()));
    while (!reads) await Bun.sleep(1);
    const streams = await Promise.all(Array.from({ length: 4 }, () => firstOverviewEvent()));
    await Bun.sleep(20); expect(reads).toBe(1);
    release();
    const [bodies, events] = await Promise.all([http, Promise.all(streams.map(stream => stream.read()))]);
    expect(bodies.every(body => body.revision === events[0].value.revision)).toBe(true);
    for (const event of events) {
      expect(event.text).not.toContain('event: work-view\n');
      expect(event.value.model.requests[0].detailLoaded).toBe(false);
    }
    streams.forEach(stream => stream.stop());
  });

  it('does not reuse a pre-commit bootstrap after a committed change or for the legacy fresh read', async () => {
    const reader = (routes as any).sourceReader; const read = reader.read.bind(reader);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    reader.read = (...args: any[]) => {
      reads++; const first = reads === 1;
      return read(...args).then(async (value: unknown) => { if (first) await gate; return value; });
    };
    const old = overview(); while (!reads) await Bun.sleep(1);
    await Bun.sleep(30);
    append('request-b', 'New committed request');
    emitContextInvalidation('all', 'test committed data', 'additive', { kinds: ['work_state'], workStateLists: ['work'] });
    const current = await overview();
    expect(current.model.requests).toHaveLength(2);
    const legacy = await (await fetch(`${origin}/api/work-view`)).json();
    expect(legacy.humanRequests).toHaveLength(2);
    expect(reads).toBe(3);
    release(); await old;
  });

  it('does not schedule rules reads for unrelated sync pages and coalesces relevant in-flight changes', async () => {
    let reads = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reader = (routes as any).sourceReader;
    const read = reader.readRules.bind(reader);
    reader.readRules = async (...args: any[]) => { reads++; if (reads === 1) await gate; return read(...args); };
    emitContextInvalidation('all', 'SyncApply.applyOps', 'additive', { kinds: ['observation'], workStateLists: [] });
    await Bun.sleep(10); expect(reads).toBe(0);
    emitContextInvalidation('all', 'SyncApply.applyOps', 'additive', { kinds: ['work_state'], workStateLists: ['my-rules'] });
    while (!reads) await Bun.sleep(1);
    for (let n = 0; n < 20; n++) emitContextInvalidation('all', 'SyncApply.applyOps', 'additive', { kinds: ['work_state'], workStateLists: ['my-rules'] });
    expect(reads).toBe(1); release();
    while (reads < 2) await Bun.sleep(1);
    await Bun.sleep(20); expect(reads).toBe(2);
  });

  for (const duringEdit of [false, true]) {
    it(`fences a pending enriched overview ${duringEdit ? 'during' : 'before'} a review write`, async () => {
      const card = (await overview()).model.requests[0];
      const held = holdEnrichedOverview(routes);
      let releaseEdit!: () => void;
      let editStarted!: () => void;
      const editReady = new Promise<void>(resolve => { editStarted = resolve; });
      const editGate = new Promise<void>(resolve => { releaseEdit = resolve; });
      if (duringEdit) {
        const target = routes as any, snapshot = target.snapshot.bind(routes);
        let paused = false;
        target.snapshot = async (...args: any[]) => {
          const value = await snapshot(...args);
          if (!args[1] && !paused) { paused = true; editStarted(); await editGate; }
          return value;
        };
      }
      const save = () => fetch(`${origin}/api/work-view/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ requestId: card.id, expectedFingerprint: card.contentFingerprint, checked: true }),
      });
      const edit = duringEdit ? save() : null;
      if (duringEdit) await editReady;
      const old = overview();
      await held.ready;
      if (duringEdit) releaseEdit();
      try {
        const saved = await (edit ?? save());
        expect(saved.status).toBe(200);
        expect((await saved.json()).humanRequests[0].review.checked).toBe(true);
        const current = await overview();
        expect(current.model.requests[0].checkedAt).toBeDefined();
      } finally { held.release(); }
      expect((await old).model.requests[0].checkedAt).toBeUndefined();
    });
  }

  it('does not reuse an enriched overview from an earlier generated-copy revision', async () => {
    const copy = { revision: 0, observe: (view: unknown) => view, close() {} };
    (routes as any).humanCopy = copy;
    const held = holdEnrichedOverview(routes);
    const old = overview();
    const before = await held.ready;
    copy.revision++;
    try { expect((await overview()).revision).not.toBe(before.revision); }
    finally { held.release(); }
    expect((await old).revision).toBe(before.revision);
  });

  it('keeps compact and detail reads under the same loopback policy as the legacy viewer', async () => {
    for (const path of ['/api/work-view/overview', '/api/work-view/requests/request-a']) {
      expect((await fetch(`${origin}${path}`, { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status).toBe(403);
    }
  });

  for (const removal of ['delete-session', 'project-merge']) {
    it(`publishes ${removal} before the cached activity deadline`, async () => {
      const stream = await firstOverviewEvent();
      const before = await stream.read();
      const fingerprint = before.value.model.requests[0].contentFingerprint;
      if (removal === 'delete-session') writer.exec('DELETE FROM work_state_entries');
      else writer.exec("UPDATE work_state_entries SET project = 'new-project'");
      emitContextInvalidation('all', removal, 'removal');
      const after = await stream.read();
      if (removal === 'delete-session') expect(after.value.model.requests).toEqual([]);
      else expect(after.value.model.requests[0].contentFingerprint).not.toBe(fingerprint);
      stream.stop();
    });
  }
});
