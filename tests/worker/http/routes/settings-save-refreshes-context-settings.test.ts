/**
 * A settings save schedules a SessionStart context re-render (Greptile
 * PRRT_kwDOPng1J86osrIo). SearchRoutes caches a settings snapshot for 5s; the
 * re-render must not run from the snapshot taken before the save, or it writes
 * the old block into the context cache.
 */
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { USER_SETTINGS_PATH } from '../../../../src/shared/paths.js';
import { contextCacheKeys } from '../../../../src/shared/context-cache.js';
import { clearPortCache } from '../../../../src/shared/worker-utils.js';

describe('settings save refreshes the context settings snapshot', () => {
  let priorSettings: string | null = null;

  beforeEach(() => {
    priorSettings = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
    mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({
      CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true',
      CLAUDE_MEM_WORKER_PORT: '38111',
    }));
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    delete process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
    clearPortCache();
  });

  afterEach(() => {
    if (priorSettings === null) rmSync(USER_SETTINGS_PATH, { force: true });
    else writeFileSync(USER_SETTINGS_PATH, priorSettings);
    clearPortCache();
  });

  it('the re-render after POST /api/settings renders the saved values, not the 5s-old snapshot', async () => {
    const sessionStore = {
      db: { prepare: mock(() => ({ get: mock(() => ({ count: 0 })) })) },
      getWorkStateEntries: mock(() => []),
    };
    const searchRoutes = new SearchRoutes({ getSessionStore: () => sessionStore } as any);
    const keys = contextCacheKeys(['settings-snapshot-proj'], 'claude', false);

    // Primes the snapshot: the welcome hint carries the viewer URL (worker port).
    const before = await searchRoutes.renderContextVariant(keys);
    expect(before.body).toContain(':38111');

    const app = express();
    app.use(express.json());
    new SettingsRoutes({} as any).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no TCP address');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '38222' }),
      });
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }

    // What ContextCacheService's scheduled re-render calls, well inside the 5s TTL.
    const after = await searchRoutes.renderContextVariant(keys);
    expect(after.body).toContain(':38222');
    expect(after.body).not.toContain(':38111');
  });
});
