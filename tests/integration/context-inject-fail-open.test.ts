import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { WorkerService } from '../../src/services/worker-service.js';
import { logger } from '../../src/utils/logger.js';

describe('WorkerService context inject fail-open', () => {
  let workerService: WorkerService | null = null;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(async () => {
    loggerSpies.forEach((spy) => spy.mockRestore());

    if (workerService) {
      const internalServer = (workerService as any).server;
      if (internalServer?.getHttpServer()) {
        try {
          await internalServer.close();
        } catch {
          // Best-effort cleanup
        }
      }
    }
  });

  it('returns empty text/plain before initialization completes', async () => {
    workerService = new WorkerService();
    const internalServer = (workerService as any).server;
    const testPort = 45000 + Math.floor(Math.random() * 10000);

    await internalServer.listen(testPort, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${testPort}/api/context/inject?projects=test-project`);
    const contentType = response.headers.get('content-type');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(contentType).toContain('text/plain');
    expect(body).toBe('');
  });
});
