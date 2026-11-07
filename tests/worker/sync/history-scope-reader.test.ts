import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SyncHistoryScopeReader } from '../../../src/services/sync/SyncHistoryScopeReader.js';
import { ViewerSyncService } from '../../../src/services/sync/ViewerSyncService.js';
import { WorkViewReadWorkerClient } from '../../../src/services/work-view/WorkViewReadWorkerClient.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });

it('returns status while historical scope is unknown and does not await its inventory', async () => {
  let finish!: (value: number) => void;
  const held = new Promise<number>(resolve => { finish = resolve; });
  const cloud = {
    status: () => ({ configured: true, pending: {}, lastFlushAt: null, lastError: null, authError: null,
      quarantine: { count: 0 }, pullQuarantine: { count: 0 },
      hub: { checkedAt: null, reachable: null, epoch: null, headSeq: null, projectedSeq: null } } as any),
    statusWithHubProbe: async () => cloud.status(), historicalExcludedCount: () => held,
  };
  const service = new ViewerSyncService({ cloud: () => cloud, pull: () => null });
  resources.push(() => service.close());
  const result = await service.statusWithProbe();
  if (!('sync' in result)) throw new Error('Expected configured status');
  expect(result.sync.completeness.scope).toBe('unknown');
  finish(7);
  await held;
  await Promise.resolve();
  expect(service.getSnapshot().completeness.excludedNative).toBe(7);
});

it('keeps HTTP and an independent initial work-view read responsive while the inventory worker is held', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-scope-isolation-'));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const inventoryPath = join(directory, 'inventory.db');
  const inventoryDb = new Database(inventoryPath);
  new SessionStore(inventoryDb);
  // Rollback mode lets this test hold a read in SQLite, without timing a CPU loop.
  inventoryDb.exec('PRAGMA journal_mode = DELETE');
  resources.push(() => { if (inventoryDb.inTransaction) inventoryDb.exec('ROLLBACK'); inventoryDb.close(); });
  const inventory = new SyncHistoryScopeReader(inventoryPath);
  resources.push(() => inventory.close());
  expect(await inventory.read()).toBe(0); // Start the worker before holding the next request.

  const viewPath = join(directory, 'view.db');
  const viewDb = new Database(viewPath);
  new SessionStore(viewDb);
  resources.push(() => viewDb.close());
  const view = new WorkViewReadWorkerClient({ databasePath: viewPath, ledgerDir: null, pollIntervalMs: 1000 });
  resources.push(() => view.close());
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true });
    const result = await view.read(0, '');
    return Response.json({ connected: result.agentView.source.connected });
  } });
  resources.push(() => server.stop(true));

  inventoryDb.exec('BEGIN EXCLUSIVE');
  let finished = false;
  const held = inventory.read().then(value => { finished = true; return value; });
  await Bun.sleep(50);
  const origin = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
  expect(await (await fetch(`${origin}/work`, { signal: AbortSignal.timeout(1000) })).json()).toEqual({ connected: true });
  expect(finished).toBe(false);
  inventoryDb.exec('ROLLBACK');
  expect(await held).toBe(0);
}, 15_000);

it('settles an owned read on close without waiting for SQLite or publishing late work', async () => {
  const reader = new SyncHistoryScopeReader('/path-that-does-not-exist/scope.db');
  const pending = reader.read();
  reader.close();
  expect(await pending).toBeNull();
  expect(await reader.read()).toBeNull();
});

it('loads the inventory role through the shipped CJS reader entrypoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-scope-bundle-'));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'source.db');
  const db = new Database(databasePath);
  new SessionStore(db);
  db.close();
  const banner = [
    'var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");',
    'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;',
  ].join('\n');
  for (const [entry, output] of [
    ['src/services/sync/SyncHistoryScopeReader.ts', 'scope-client.cjs'],
    ['src/services/work-view/work-view-read-worker.ts', 'work-view-read-worker.cjs'],
  ]) {
    await build({ entryPoints: [entry], outfile: join(directory, output), bundle: true, platform: 'node', target: 'node18', format: 'cjs',
      external: ['bun:sqlite'], define: { 'import.meta.url': '__IMPORT_META_URL__' }, banner: { js: banner }, logLevel: 'silent' });
  }
  const bundled = await import(pathToFileURL(join(directory, 'scope-client.cjs')).href);
  const reader = new bundled.SyncHistoryScopeReader(databasePath) as SyncHistoryScopeReader;
  resources.push(() => reader.close());
  expect(await reader.read()).toBe(0);
});
