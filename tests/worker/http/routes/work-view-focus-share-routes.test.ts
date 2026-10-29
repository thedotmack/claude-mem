import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';

// The share list and comments hold secret links: only the viewer's own page may read them.
let directory: string;
let routes: WorkViewRoutes;
let server: Server;
let origin: string;

const entry = { token: 'a'.repeat(32), url: `https://cmem.ai/focus/${'a'.repeat(32)}`, sharedAt: '2026-10-29T20:00:00.000Z', publishedAt: null, pageHash: null };
const fakeShares = {
  connected: () => true,
  list: () => ({ 'area-1': entry }),
  publish: async () => ({ entry, sent: true }),
  stop: async () => {},
  comments: async () => ({ comments: [], publishedAt: null }),
  comment: async () => { throw new Error('not used'); },
};

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-focus-share-'));
  const databasePath = join(directory, 'source.db');
  const source = new Database(databasePath);
  source.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  source.close();
  routes = new WorkViewRoutes({
    databasePath, reviewPath: join(directory, 'review.db'), humanCopy: null, ledgerDir: null,
    setupStatePath: join(directory, 'setup-state.json'), focusShares: fakeShares, focusSharePublishEveryMs: 0,
  });
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
});

describe('focus share routes', () => {
  for (const path of ['/api/work-view/focus/shares', '/api/work-view/focus/share/comments?focusAreaId=area-1']) {
    it(`refuses another local page reading ${path.split('?')[0]}`, async () => {
      for (const headers of [{ Origin: 'http://localhost:1' }, { Origin: 'http://127.0.0.1:3' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        expect((await fetch(`${origin}${path}`, { headers })).status).toBe(403);
      }
      expect((await fetch(`${origin}${path}`, { headers: { Origin: origin } })).status).toBe(200);
      expect((await fetch(`${origin}${path}`)).status).toBe(200);
    });
  }

  it('lists links for the viewer with the worker\'s last update error', async () => {
    const body = await (await fetch(`${origin}/api/work-view/focus/shares`)).json();
    expect(body).toEqual({ connected: true, shares: { 'area-1': { url: entry.url, sharedAt: entry.sharedAt, publishedAt: null, publishError: null } } });
  });
});
