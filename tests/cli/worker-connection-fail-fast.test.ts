import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockLogger: Record<string, any> = {
  warn: () => {},
  debug: () => {},
  info: () => {},
  error: () => {},
};

mock.module('../../src/utils/logger.js', () => ({
  logger: mockLogger,
}));

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: () => '/tmp/claude-mem-data',
    loadFromFile: () => ({
      CLAUDE_MEM_WORKER_PORT: '37777',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    }),
  },
}));


describe('CLI worker connection handling', () => {
  const originalFetch = global.fetch;

  let warnMock: ReturnType<typeof mock>;
  let debugMock: ReturnType<typeof mock>;

  beforeEach(() => {
    warnMock = mock(() => {});
    debugMock = mock(() => {});

    mockLogger.warn = warnMock;
    mockLogger.debug = debugMock;
    mockLogger.info = mock(() => {});
    mockLogger.error = mock(() => {});

    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fails fast with a single health-check attempt on ECONNREFUSED', async () => {
    const { clearPortCache, ensureWorkerRunning } = await import(
      '../../src/shared/worker-utils.js?worker-connection-fail-fast'
    );
    clearPortCache();

    const fetchMock = mock(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:37777')));
    global.fetch = fetchMock as typeof global.fetch;

    const startedAt = Date.now();
    const result = await ensureWorkerRunning();
    const elapsedMs = Date.now() - startedAt;

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/health');

    expect(debugMock).toHaveBeenCalledTimes(1);
    expect(String(debugMock.mock.calls[0][1])).toContain('Worker health check failed');
    expect(String(debugMock.mock.calls[0][2]?.error)).toContain('ECONNREFUSED');

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][1])).toContain('Worker not healthy, hook will proceed gracefully');

    expect(elapsedMs).toBeLessThan(250);
  });
});
