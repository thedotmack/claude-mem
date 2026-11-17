import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ContextReadTimeoutError } from '../../src/services/context/ContextReadWorkerClient.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { ContextCacheService } from '../../src/services/worker/ContextCacheService.js';
import { contextCacheKeys } from '../../src/shared/context-cache.js';
import { logger } from '../../src/utils/logger.js';

async function inject(contextReader: unknown, query = 'projects=app'): Promise<{ status: number; body: unknown }> {
  const routes = new SearchRoutes({ getSessionStore: () => ({ getLocalSyncDeviceId: () => '' }) } as any, undefined, null, contextReader as any);
  const app = express();
  routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/context/inject?${query}`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function readerThatFails(error: Error): unknown {
  const fail = () => Promise.reject(error);
  return { render: fail, workState: fail, hasObservations: fail, readKeys: fail, projectsForCwd: fail };
}

describe('context injection when a context read runs past the deadline', () => {
  const sunk: unknown[] = [];

  afterEach(() => {
    logger.setErrorSink(null);
    sunk.length = 0;
  });

  it.each([
    ['projects', 'projects=app'],
    ['cwd only', 'cwd=%2Ftmp%2Fapp'],
  ])('answers 500 without an error-tracking exception when the request names %s', async (_label, query) => {
    logger.setErrorSink(error => sunk.push(error));

    const result = await inject(readerThatFails(new ContextReadTimeoutError(120_000, 'render', 80_000, 40_000)), query);

    expect(result).toEqual({ status: 500, body: { error: 'Context reader timed out after 120000ms' } });
    expect(sunk).toHaveLength(0);
  });

  it('still reports any other reader failure to error tracking', async () => {
    logger.setErrorSink(error => sunk.push(error));

    const result = await inject(readerThatFails(new Error('Context reader exited with code 1')));

    expect(result.status).toBe(500);
    expect(sunk.length).toBeGreaterThan(0);
  });

  it('logs a cache re-render that hits the deadline as a warning', async () => {
    logger.setErrorSink(error => sunk.push(error));
    let renders = 0;
    const service = new ContextCacheService({
      debounceMs: 10,
      renderVariant: () => {
        renders++;
        return Promise.reject(new ContextReadTimeoutError(120_000, 'workState', 0, 120_000));
      },
      expandProjectReadKeys: projects => projects,
    });
    service.recordLiveRender(contextCacheKeys(['timeout-cache-app'], undefined, false), { body: '', cacheable: false, readKeys: [] }, Date.now());
    service.setServable(false);
    service.setServable(true);
    await service.flushPendingRenders();
    service.stop();

    expect(renders).toBe(1);
    expect(sunk).toHaveLength(0);
  });
});
