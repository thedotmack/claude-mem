// SPDX-License-Identifier: Apache-2.0
//
// #2550 — in-process server-runtime smoke test (always runs in CI, no Docker).
//
// This is the non-Docker counterpart to scripts/e2e-server-beta-docker.sh. It
// boots the server runtime's HTTP surface in-process against an in-memory
// SQLite DB and proves the four GA-gating facts from the plan-07 test matrix
// that DON'T require a real pg/redis container:
//   1. a mode is loaded (the #2443 boot guard succeeds)
//   2. an API key can be created (the operator key-gen path works)
//   3. an authed request succeeds with that key (auth contract holds end-to-end)
//   4. the viewer responds (the #2552 static handler is mounted)
//
// The full queue-durability / restart-recovery matrix stays in the Docker e2e.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js';
import { ServerViewerRoutes } from '../../src/server/runtime/ServerViewerRoutes.js';
import { createServerApiKey, DEFAULT_LOCAL_API_KEY_SCOPES } from '../../src/server/auth/sqlite-api-key-service.js';
import { loadServerBetaMode } from '../../src/server/runtime/create-server-beta-service.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { logger } from '../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('server runtime in-process smoke (#2550)', () => {
  let db: Database;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');

    const options: ServerOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
    };
    server = new Server(options);
    // Mount the same handlers the server runtime mounts: V1 routes (api-key
    // auth) + the viewer static handler (#2552).
    server.registerRoutes(new ServerV1Routes({
      getDatabase: () => db,
      authMode: 'api-key',
      runtime: 'server-beta',
    }));
    server.registerRoutes(new ServerViewerRoutes());
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected server to bind to an ephemeral TCP port');
    }
    port = address.port;
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch (error: any) {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    db.close();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('loads a mode at boot (the #2443 guard succeeds)', () => {
    // loadServerBetaMode() is the exact boot guard the real server calls; it
    // throws if no mode can be loaded.
    expect(() => loadServerBetaMode()).not.toThrow();
    expect(ModeManager.getInstance().getActiveMode()).toBeDefined();
  });

  it('reports the server runtime on /v1/info', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/info`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtime).toBe('server-beta');
    expect(body.authMode).toBe('api-key');
  });

  it('rejects an unauthenticated request (auth contract enforced)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/projects`);
    expect(res.status).toBe(401);
  });

  it('creates an API key and an authed request succeeds with it', async () => {
    const created = createServerApiKey(db, { name: 'smoke-key' });
    // The default key gets the scopes the local routes require.
    expect(created.record.scopes).toEqual([...DEFAULT_LOCAL_API_KEY_SCOPES]);

    // Write route — must be authorized.
    const writeRes = await fetch(`http://127.0.0.1:${port}/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.rawKey}` },
      body: JSON.stringify({ name: 'Smoke Project' }),
    });
    expect(writeRes.status).toBe(201);
    const { project } = await writeRes.json();

    // Read route with the same key — must be authorized and return the project.
    const readRes = await fetch(`http://127.0.0.1:${port}/v1/projects`, {
      headers: { Authorization: `Bearer ${created.rawKey}` },
    });
    expect(readRes.status).toBe(200);
    const { projects } = await readRes.json();
    expect(projects.map((p: any) => p.id)).toContain(project.id);
  });

  it('serves the viewer at / (the #2552 static handler is mounted)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    // 200 when the build shipped viewer.html; 503 only if no viewer.html exists
    // at any expected path. Either way the handler is mounted (not a 404).
    if (ServerViewerRoutes.hasViewerHtml()) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    } else {
      expect(res.status).toBe(503);
    }
    expect(res.status).not.toBe(404);
  });
});
