import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Drives what loadFromFileOnce() returns per test (the settings object).
let settings: Record<string, unknown> = {};

// Record fetch calls so we can assert the worker was never contacted in the
// opt-out path (no health check, no lazy-spawn).
const fetchLog: Array<{ url: string; method: string }> = [];

mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => settings,
}));

// For the default (autostart on) path, present a healthy/version-matched worker
// so ensureWorkerRunning() resolves true without an actual spawn.
// NB: supervisor/index.js is imported by the spawn chain (ProcessManager) for
// getSupervisor() too — mocking the module replaces the whole namespace, so we
// must stub every export the chain pulls in or its static import fails to load.
// getSupervisor() is not reached on these paths (the worker reports 'alive'); the
// stub exists only so the import resolves.
mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'alive',
  getSupervisor: () => ({
    assertCanSpawn: () => {},
    registerProcess: () => {},
    unregisterProcess: () => {},
    getRegistry: () => ({ reapSession: () => {} }),
    stop: () => Promise.resolve(),
  }),
}));
mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () =>
    Promise.resolve({ matches: true, pluginVersion: '13.4.1', workerVersion: '13.4.1' }),
}));

function installFetchMock(): void {
  fetchLog.length = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    fetchLog.push({ url: u, method: (init?.method ?? 'GET').toUpperCase() });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('ensureWorkerAliveOnce — CLAUDE_MEM_WORKER_AUTOSTART opt-out', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    installFetchMock();
    const { resetAliveCache } = await import('../../src/shared/worker-utils.js');
    resetAliveCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  it('returns false and never contacts the worker when AUTOSTART=false', async () => {
    settings = { CLAUDE_MEM_WORKER_AUTOSTART: 'false' };

    const { ensureWorkerAliveOnce } = await import('../../src/shared/worker-utils.js');

    expect(await ensureWorkerAliveOnce()).toBe(false);
    expect(fetchLog).toHaveLength(0); // short-circuited before any spawn/health check
  });

  it('proceeds normally (true for a live worker) when AUTOSTART is unset (default)', async () => {
    settings = {};

    const { ensureWorkerAliveOnce } = await import('../../src/shared/worker-utils.js');

    expect(await ensureWorkerAliveOnce()).toBe(true);
  });

  it('treats AUTOSTART=true the same as unset', async () => {
    settings = { CLAUDE_MEM_WORKER_AUTOSTART: 'true' };

    const { ensureWorkerAliveOnce } = await import('../../src/shared/worker-utils.js');

    expect(await ensureWorkerAliveOnce()).toBe(true);
  });
});
