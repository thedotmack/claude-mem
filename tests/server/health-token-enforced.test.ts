// GET /api/health is the one route that never needs the local API token, so it
// is where a client learns whether the token is enforced before it calls any
// other route. This checks the flag the route reports in both modes.

import { describe, expect, it } from 'bun:test';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import type { LocalApiTokenOptions } from '../../src/services/worker/http/middleware.js';
import { listenOnEphemeralPort } from '../helpers/ephemeral-port.js';

function options(localApiToken?: LocalApiTokenOptions): ServerOptions {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '/test/worker-service.cjs',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    ...(localApiToken ? { localApiToken } : {}),
  };
}

async function healthBody(server: Server): Promise<{ tokenEnforced?: boolean }> {
  const port = await listenOnEphemeralPort(server);
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  expect(response.status).toBe(200);
  return await response.json() as { tokenEnforced?: boolean };
}

describe('GET /api/health token state', () => {
  it('reports tokenEnforced true when a local API token is configured', async () => {
    const server = new Server(options({ getToken: () => 'local-api-token-value' }));
    const body = await healthBody(server);
    expect(body.tokenEnforced).toBe(true);
    await server.close();
  });

  it('reports tokenEnforced false when no token is configured', async () => {
    const server = new Server(options());
    const body = await healthBody(server);
    expect(body.tokenEnforced).toBe(false);
    await server.close();
  });
});