import express from 'express';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { ContextCacheService } from '../../../src/services/worker/ContextCacheService.js';
import { contextCacheKeys, readContextCache } from '../../../src/shared/context-cache.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { WorkStateRoutes } from '../../../src/services/worker/http/routes/WorkStateRoutes.js';
import { buildWorkStateContextSection } from '../../../src/services/context/sections/WorkStateRenderer.js';
import { getProjectContext } from '../../../src/utils/project-name.js';

const checkout = join(process.env.CLAUDE_MEM_DATA_DIR!, 'checkout');
mkdirSync(checkout, { recursive: true });
const project = getProjectContext(checkout).primary;
const keys = contextCacheKeys([project], 'claude', false);
const store = new SessionStore(':memory:');
const render = () => ({
  body: ['Stored memory', buildWorkStateContextSection(store.getWorkStateEntries([project]), 'placeholders')].filter(Boolean).join('\n'),
  cacheable: true,
  readKeys: store.getProjectReadKeys([project]),
});
let service: ContextCacheService | undefined;
let server: Server | undefined;
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
let started!: () => void;
const expanding = new Promise<void>(resolve => { started = resolve; });
let blockExpansion = process.argv[2] === 'expanding';

try {
  store.appendWorkStateEntry({ project, listName: 'release', fields: { task: 'ship release', status: 'todo' } });
  // A previous worker wrote both the body and its persisted variant index.
  service = new ContextCacheService({
    debounceMs: 60_000,
    expandProjectReadKeys: projects => store.getProjectReadKeys(projects),
    renderVariant: async () => render(),
  });
  service.start();
  await service.recordLiveRender(keys, render(), Date.now());
  service.stop();

  service = new ContextCacheService({
    debounceMs: 60_000,
    expandProjectReadKeys: async projects => {
      if (blockExpansion) {
        started();
        await gate;
        blockExpansion = false;
      }
      return store.getProjectReadKeys(projects);
    },
    renderVariant: async () => render(),
  });
  service.start();
  const before = readContextCache(keys)?.body;
  const refreshing = blockExpansion ? service.flushPendingRenders() : undefined;
  if (refreshing) await expanding;

  const app = express();
  app.use(express.json());
  new WorkStateRoutes({ getSessionStore: () => store, getCloudSync: () => null } as any).setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/work-state/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: checkout, list: 'release', fields: { task: 'ship release', status: 'done' } }),
  });
  const responseBody = await response.text();
  const immediatelyAfterWrite = readContextCache(keys)?.body ?? null;
  release();
  await refreshing;
  await service.flushPendingRenders();
  console.log(JSON.stringify({
    before, status: response.status, responseBody, immediatelyAfterWrite,
    afterRefresh: readContextCache(keys)?.body ?? null,
    storedFields: store.getWorkStateEntries([project], 'release').map(entry => entry.fields),
  }));
} finally {
  release();
  service?.stop();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  store.close();
}
