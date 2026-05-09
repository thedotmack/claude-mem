import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ServerBetaService } from '../../src/server/runtime/ServerBetaService.js';
import {
  DisabledServerBetaEventBroadcaster,
  DisabledServerBetaGenerationWorkerManager,
  DisabledServerBetaProviderRegistry,
  DisabledServerBetaQueueManager,
  type ServerBetaServiceGraph,
} from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';

const loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ServerBetaService', () => {
  let service: ServerBetaService | null = null;

  afterEach(async () => {
    if (service) {
      await service.stop();
      service = null;
    }
    loggerSpies.splice(0).forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('serves server-beta runtime labels from independent runtime routes', async () => {
    loggerSpies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    );

    service = new ServerBetaService({
      graph: createTestGraph(),
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const address = service.getRuntimeState();

    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).runtime).toBe('server-beta');

    const info = await fetch(`http://127.0.0.1:${address.port}/v1/info`);
    expect(info.status).toBe(200);
    const body = await info.json();
    expect(body.runtime).toBe('server-beta');
    expect(body.boundaries.queueManager.status).toBe('disabled');
  });
});

function createTestGraph(): ServerBetaServiceGraph {
  return {
    runtime: 'server-beta',
    postgres: {
      pool: {
        end: mock(() => Promise.resolve()),
      } as any,
      bootstrap: {
        initialized: true,
        schemaVersion: 1,
        appliedAt: new Date(0).toISOString(),
      },
    },
    authMode: 'local-dev',
    queueManager: new DisabledServerBetaQueueManager('test'),
    generationWorkerManager: new DisabledServerBetaGenerationWorkerManager('test'),
    providerRegistry: new DisabledServerBetaProviderRegistry('test'),
    eventBroadcaster: new DisabledServerBetaEventBroadcaster('test'),
    storage: {} as any,
  };
}
