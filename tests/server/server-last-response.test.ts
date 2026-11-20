import { describe, expect, it, mock } from 'bun:test';
import type express from 'express';
import { Server } from '../../src/services/server/Server.js';

// The worker's liveness heartbeat publishes when the worker last FINISHED an
// HTTP response, so a hook can tell a slow worker that still answers from one
// whose every request hangs. Only a finished response counts.

function server(routes?: (app: express.Application) => void): Server {
  const instance = new Server({
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: mock(() => Promise.resolve()),
    onRestart: mock(() => Promise.resolve()),
    workerPath: '/test/worker.cjs',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'none', lastInteraction: null }),
  });
  if (routes) instance.registerRoutes({ setupRoutes: routes });
  instance.finalizeRoutes();
  return instance;
}

async function start(instance: Server): Promise<number> {
  await instance.listen(0, '127.0.0.1');
  const address = instance.getHttpServer()?.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

// Same shutdown tolerance as the other Server tests: under bun, close() after
// closeAllConnections() can report the server as already stopped.
async function stop(instance: Server): Promise<void> {
  try {
    await instance.close();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
  }
}

describe('Server last finished response', () => {
  it('is null before any response, and stamped when /api/health finishes', async () => {
    const instance = server();
    const port = await start(instance);
    try {
      expect(instance.getLastResponseFinishedAt()).toBeNull();
      const before = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      await response.text();
      expect(response.status).toBe(200);
      // 'finish' fires once the last byte is handed to the socket; allow it a tick.
      for (let attempt = 0; attempt < 100 && instance.getLastResponseFinishedAt() === null; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(instance.getLastResponseFinishedAt()).toBeGreaterThanOrEqual(before);
    } finally {
      await stop(instance);
    }
  });

  it('is not stamped by a request that never gets an answer', async () => {
    const instance = server(app => {
      app.get('/api/test-hang', () => { /* never answers */ });
    });
    const port = await start(instance);
    try {
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/api/test-hang`, { signal: controller.signal }).catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 100));
      controller.abort();
      await pending;
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(instance.getLastResponseFinishedAt()).toBeNull();
    } finally {
      await stop(instance);
    }
  });
});
