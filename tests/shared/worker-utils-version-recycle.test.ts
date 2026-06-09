import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };

// Record every HTTP call the worker layer makes, so we can assert whether a
// restart was (or was not) issued. fetch is what workerHttpRequest ultimately
// calls via fetchWithTimeout.
const fetchLog: Array<{ url: string; method: string }> = [];

// Controls what checkVersionMatch reports for a given test.
let versionMatchResult: { matches: boolean; pluginVersion: string; workerVersion: string | null } = {
  matches: true,
  pluginVersion: '13.4.0',
  workerVersion: '13.4.0',
};

// A worker is "alive" (healthy + pid ok) for these tests; we exercise the
// version-mismatch branch, not the lazy-spawn-from-dead path.
mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve(versionMatchResult),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'alive',
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-version-recycle=${Date.now()}-${Math.random()}`);
}

function installFetchMock(): void {
  fetchLog.length = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchLog.push({ url: u, method });

    // /api/health and /api/readiness must report OK so the worker is "alive"
    // and "ready"; /api/admin/restart and anything else also returns OK.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('ensureWorkerRunning — stale-worker recycle on version mismatch', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
  });

  it('POSTs /api/admin/restart when the running worker version differs', async () => {
    versionMatchResult = { matches: false, pluginVersion: '13.4.0', workerVersion: '13.3.0' };

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    await ensureWorkerRunning();

    const restartCalls = fetchLog.filter(
      c => c.url.includes('/api/admin/restart') && c.method === 'POST'
    );
    expect(restartCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT restart when versions match', async () => {
    versionMatchResult = { matches: true, pluginVersion: '13.4.0', workerVersion: '13.4.0' };

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    await ensureWorkerRunning();

    const restartCalls = fetchLog.filter(c => c.url.includes('/api/admin/restart'));
    expect(restartCalls.length).toBe(0);
  });
});
