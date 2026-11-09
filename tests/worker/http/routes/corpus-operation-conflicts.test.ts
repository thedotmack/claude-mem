import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { CorpusRoutes } from '../../../../src/services/worker/http/routes/CorpusRoutes.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function corpus(name: string, count = 1) {
  return {
    version: 1 as const, name, description: '', created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', filter: {}, session_id: null,
    system_prompt: '', observations: [],
    stats: { observation_count: count, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} },
  };
}

function storeFixture(caseInsensitive = false) {
  const rows = new Map<string, any>([['alpha', corpus('alpha')], ['beta', corpus('beta')]]);
  const key = (name: string) => caseInsensitive ? name.trim().toLowerCase() : name.trim();
  return {
    read: (name: string) => structuredClone(rows.get(key(name)) ?? null),
    write: (value: any) => { rows.set(key(value.name), structuredClone(value)); },
    delete: (name: string) => rows.delete(key(name)),
    list: () => [...rows.values()],
  };
}

async function serve(routes: CorpusRoutes): Promise<{ server: Server; url: string }> {
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const post = (url: string, body = {}, signal?: AbortSignal) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});

describe('corpus operations preserve one another', () => {
  it('keeps differently cased aliases in the same operation on case-insensitive volumes', async () => {
    // Filesystem case sensitivity is a volume property, not an OS property:
    // this models the default macOS volume even when the test runs on Linux.
    const store = storeFixture(true);
    const entered = deferred(); const release = deferred();
    const agent = { prime: async (value: any) => {
      entered.resolve(); await release.promise;
      store.write({ ...value, session_id: 'primed' }); return 'primed';
    } };
    const { server, url } = await serve(new CorpusRoutes(store as any, {} as any, agent as any));
    const prime = post(url + '/api/corpus/Alpha/prime');
    try {
      await entered.promise;
      const deletion = await fetch(url + '/api/corpus/alpha', { method: 'DELETE' });
      assert.equal(deletion.status, 409, 'a case alias must not delete the file under the active prime');
      assert.equal((await deletion.json() as any).code, 'CORPUS_BUSY');
      assert.notEqual(store.read('ALPHA'), null);
      release.resolve();
      assert.equal((await prime).status, 200);
      assert.equal((await fetch(url + '/api/corpus/ALPHA', { method: 'DELETE' })).status, 200);
      assert.equal(store.read('alpha'), null);
    } finally {
      release.resolve(); await prime; await close(server);
    }
  });

  it('refuses conflicting work and deletion before dispatch, across route instances, then permits a fresh rebuild', async () => {
    const store = storeFixture();
    const entered = deferred(); const release = deferred();
    let builds = 0;
    const builder = { build: async (name: string) => { builds++; return corpus(name, 2); } };
    const agent = { prime: async (value: any) => {
      entered.resolve(); await release.promise;
      store.write({ ...value, session_id: 'primed' }); return 'primed';
    } };
    const a = await serve(new CorpusRoutes(store as any, builder as any, agent as any));
    const b = await serve(new CorpusRoutes(store as any, builder as any, agent as any));
    const prime = post(a.url + '/api/corpus/alpha/prime');
    try {
      await entered.promise;
      const rebuild = await post(b.url + '/api/corpus/alpha/rebuild');
      assert.equal(rebuild.status, 409);
      assert.equal((await rebuild.json() as any).code, 'CORPUS_BUSY');
      assert.equal((await fetch(b.url + '/api/corpus/alpha', { method: 'DELETE' })).status, 409);
      assert.equal(builds, 0);
      assert.equal(store.read('alpha').stats.observation_count, 1);
      assert.equal((await post(b.url + '/api/corpus/beta/rebuild')).status, 200);
      assert.equal(builds, 1);
      release.resolve();
      assert.equal((await prime).status, 200);
      assert.equal((await post(b.url + '/api/corpus/alpha/rebuild')).status, 200);
      assert.equal(store.read('alpha').stats.observation_count, 2);
      assert.equal((await fetch(b.url + '/api/corpus/alpha', { method: 'DELETE' })).status, 200);
      assert.equal(store.read('alpha'), null);
    } finally {
      release.resolve(); await prime;
      await Promise.all([close(a.server), close(b.server)]);
    }
  });

  it('releases a failed operation so the owner can try again', async () => {
    const store = storeFixture(); let calls = 0;
    const agent = { prime: async () => { if (++calls === 1) throw new Error('fixture failure'); return 'ok'; } };
    const { server, url } = await serve(new CorpusRoutes(store as any, {} as any, agent as any));
    try {
      assert.equal((await post(url + '/api/corpus/alpha/prime')).status, 500);
      assert.equal((await post(url + '/api/corpus/alpha/prime')).status, 200);
      assert.equal(calls, 2);
    } finally { await close(server); }
  });

  it('keeps a disconnected build admitted until its actual work settles', async () => {
    const store = storeFixture(); const entered = deferred(); const release = deferred();
    const builder = { build: async () => { entered.resolve(); await release.promise; return corpus('alpha', 2); } };
    const agent = { prime: async () => 'ok' };
    const routes = new CorpusRoutes(store as any, builder as any, agent as any);
    const { server, url } = await serve(routes);
    const abort = new AbortController();
    const build = post(url + '/api/corpus', { name: 'alpha' }, abort.signal).catch(error => error);
    try {
      await entered.promise; abort.abort(); await build;
      assert.equal((await post(url + '/api/corpus/alpha/prime')).status, 409);
      assert.equal(routes.corpusBuildsRunning(), 1);
      release.resolve();
      const deadline = Date.now() + 2_000;
      while (routes.corpusBuildsRunning() > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal((await post(url + '/api/corpus/alpha/prime')).status, 200);
    } finally { release.resolve(); await build; await close(server); }
  });
});
