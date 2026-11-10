// SPDX-License-Identifier: Apache-2.0
//
// #2550 — in-process server-runtime smoke test (always runs in CI, no Docker).
//
// Boots the server HTTP surface against an in-memory SQLite DB and verifies
// the runtime labels and unauthenticated-request rejection.
//
// The full queue-durability / restart-recovery matrix stays in the Docker e2e.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js';
import { ServerViewerRoutes } from '../../src/server/runtime/ServerViewerRoutes.js';
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
});
