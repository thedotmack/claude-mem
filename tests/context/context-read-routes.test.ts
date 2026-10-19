import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const routeScript = `
  import express from 'express';
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
  import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
  import { contextCacheKeys, readContextCache } from './src/shared/context-cache.ts';
  import { resolveRuntimeContext } from './src/services/hooks/runtime-selector.ts';
  const directory = process.env.CLAUDE_MEM_DATA_DIR;
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({
    CLAUDE_MEM_RUNTIME: process.env.CLAUDE_MEM_RUNTIME,
    CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false', CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true',
    CLAUDE_MEM_WORK_STATE_ENABLED: 'true', CLAUDE_MEM_WORKER_PORT: '1',
    CLAUDE_MEM_SERVER_URL: 'http://127.0.0.1:1', CLAUDE_MEM_SERVER_API_KEY: 'fixture-key', CLAUDE_MEM_SERVER_PROJECT_ID: 'fixture-project',
  }));
  ModeManager.getInstance().loadMode('code');
  Date.now = () => 1790000000000;
  const store = new SessionStore(join(directory, 'claude-mem.db'));
  store.appendWorkStateEntry({ project: 'app', listName: 'next', fields: { status: 'active', next: 'KEEP_RUNTIME_WORK_STATE' }, createdAtEpoch: 1700000000000 });
  const remoteEntry = store.appendWorkStateEntry({ project: 'app', listName: 'next', fields: { next: 'WRONG_REMOTE_WORK_STATE' }, createdAtEpoch: 1700000000000 });
  const remoteStatement = store.db.prepare('UPDATE work_state_entries SET origin_device_id = ?, origin_local_id = ? WHERE id = ?');
  try { remoteStatement.run('device-a', '7', remoteEntry); } finally { remoteStatement.finalize(); }
  store.setLocalSyncDeviceId('device-z');
  if (process.env.FIXTURE_WITH_OBSERVATIONS === 'true') {
    const session = store.createSDKSession('route-content', 'app', 'route memory');
    store.ensureMemorySessionIdRegistered(session, 'route-memory');
    store.storeObservation('route-memory', 'app', { type: 'discovery', title: 'KEEP_ROUTE_RECORD', subtitle: null,
      facts: [], narrative: 'Route-level isolated memory.', concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1);
  }
  const checkout = join(directory, 'checkout/app'); mkdirSync(checkout, { recursive: true });
  const manager = { getSessionStore: () => store };
  const reader = new ContextReadWorkerClient();
  const cache = new ContextCacheService({
    renderVariant: keys => wired.renderContextVariant(keys),
    expandProjectReadKeys: projects => process.env.FAIL_CACHE_KEYS === 'true'
      ? Promise.reject(new Error('Synthetic cache alias lookup failure'))
      : reader.readKeys(projects),
  });
  const wired = new SearchRoutes(manager, cache, null, reader);
  const inline = new SearchRoutes(manager);
  const wiredApp = express(); wired.setupRoutes(wiredApp);
  const inlineApp = express(); inline.setupRoutes(inlineApp);
  const app = express(); app.use('/wired', wiredApp); app.use('/inline', inlineApp);
  cache.start();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const query = new URLSearchParams({ cwd: checkout });
    const root = 'http://127.0.0.1:' + server.address().port;
    const before = await fetch(root + '/inline/api/context/inject?' + query);
    const beforeBody = await before.text();
    const response = await fetch(root + '/wired/api/context/inject?' + query);
    const body = await response.text();
    const cached = readContextCache(contextCacheKeys(['app'], undefined, false));
    console.log(JSON.stringify({ runtime: resolveRuntimeContext().runtime, inlineStatus: before.status, status: response.status, body, sameBody: beforeBody === body, cached: Boolean(cached?.body.includes('KEEP_RUNTIME_WORK_STATE')), hasRecord: body.includes('KEEP_ROUTE_RECORD') }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    cache.stop(); await reader.close(); store.close();
    process.exit(0);
  }
`;

describe('local context routes with an isolated reader', () => {
  it.each([
    ['worker runtime', 'worker', false],
    ['server runtime', 'server', false],
    ['server runtime with cache lookup failure', 'server', true],
  ] as const)('%s preserves the response', (_label, runtime, failCacheKeys) => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-reader-routes-'));
    try {
      writeFileSync(join(directory, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: runtime, CLAUDE_MEM_SERVER_URL: 'http://127.0.0.1:1',
        CLAUDE_MEM_SERVER_API_KEY: 'fixture-key', CLAUDE_MEM_SERVER_PROJECT_ID: 'fixture-project',
        CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false', CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true', CLAUDE_MEM_WORK_STATE_ENABLED: 'true',
      }));
      const result = Bun.spawnSync([process.execPath, '-e', routeScript], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_MEM_RUNTIME: runtime,
          CLAUDE_MEM_MODES_DIR: join(process.cwd(), 'plugin/modes'), CLAUDE_MEM_TELEMETRY_ENABLED: 'false', CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false', CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true', CLAUDE_MEM_WORK_STATE_ENABLED: 'true',
          FIXTURE_WITH_OBSERVATIONS: String(runtime === 'worker'), FAIL_CACHE_KEYS: String(failCacheKeys) },
      });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      const value = JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
      expect(value.runtime).toBe(runtime);
      expect(value.inlineStatus).toBe(200);
      expect(value.status).toBe(200);
      expect(value.body).toContain('KEEP_RUNTIME_WORK_STATE');
      expect(value.body).not.toContain('WRONG_REMOTE_WORK_STATE');
      expect(value.hasRecord).toBe(runtime === 'worker');
      if (runtime === 'worker') expect(value.body).toContain('KEEP_ROUTE_RECORD');
      else expect(value.body).toContain('This project has no memory yet');
      expect(value.sameBody).toBe(true);
      expect(value.cached).toBe(!failCacheKeys);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
