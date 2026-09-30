import { describe, it, expect, afterEach, afterAll, mock } from 'bun:test';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realSpawn from '../../src/shared/spawn.js';

// I-4 (bwrap --unshare-pid): a caller inside a PID namespace gets ESRCH from
// process.kill(hostPid, 0) even though the host worker is healthy, so
// validateWorkerPidFile reports 'stale'. isWorkerPortAlive() (private to
// worker-utils.ts, exercised here through ensureWorkerRunning) must treat a
// 'stale' verdict as alive when the HTTP health probe already succeeded —
// health, not pid visibility, is the ground truth once it has been proven.

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
// Snapshot taken before any mock.module call: restoring with
// `require('../../src/shared/spawn.js')` would hand back the mocked module
// (pid 9999) and leak it into every later test file in the same bun process.
const realSpawnSnapshot = { ...realSpawn };

let validateWorkerPidFileResult: 'missing' | 'alive' | 'stale' | 'invalid' = 'stale';
// Records the options every validateWorkerPidFile call received, so the test
// fails if isWorkerPortAlive() stops passing removeStale:false (the flag is
// what keeps the real validator from rmSync'ing the host worker's pid file).
const validateWorkerPidFileOptions: Array<{ removeStale?: boolean } | undefined> = [];

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve({ matches: true, pluginVersion: '13.4.0', workerVersion: '13.4.0' }),
  isPortInUse: () => Promise.resolve(false),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: (options?: { removeStale?: boolean }) => {
    validateWorkerPidFileOptions.push(options);
    return validateWorkerPidFileResult;
  },
  readOwnedWorkerPidInfo: () => null,
}));

// If the bug under test makes isWorkerPortAlive() report false (buggy path),
// ensureWorkerRunning falls through to the real lazy-spawn machinery, which
// shells out to resolve a Bun runtime on PATH — slow/blocking in this
// sandbox. Force a fast, deterministic "can't spawn" so a RED run fails on
// the assertion, not on a hang.
mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  resolveWorkerRuntimePath: () => null,
}));

afterAll(() => {
  mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
  mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
  mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManager);
  mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
});

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-pidns=${Date.now()}-${Math.random()}`);
}

function okResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function failResponse(): Response {
  return { ok: false, status: 503, text: () => Promise.resolve(''), json: () => Promise.resolve({}) } as unknown as Response;
}

describe('isWorkerPortAlive (via ensureWorkerRunning) — stale pid file but healthy port (I-4)', () => {
  const originalFetch = global.fetch;
  let spawnCalled = false;

  afterEach(() => {
    global.fetch = originalFetch;
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
    validateWorkerPidFileResult = 'stale';
    validateWorkerPidFileOptions.length = 0;
  });

  it('treats a stale pid file as alive when the health endpoint already answered ok', async () => {
    validateWorkerPidFileResult = 'stale';
    validateWorkerPidFileOptions.length = 0;
    global.fetch = mock((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/health')) return Promise.resolve(okResponse({ version: '13.4.0' }));
      if (u.includes('/api/readiness')) return Promise.resolve(okResponse({}));
      return Promise.resolve(failResponse());
    }) as unknown as typeof fetch;

    spawnCalled = false;
    mock.module('../../src/shared/spawn.js', () => ({
      spawnHidden: (...args: unknown[]) => {
        spawnCalled = true;
        return { pid: 9999, unref: () => {}, on: () => {} };
      },
    }));

    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
    expect(spawnCalled).toBe(false);
    expect(validateWorkerPidFileOptions.length).toBeGreaterThan(0);
    for (const options of validateWorkerPidFileOptions) {
      expect(options?.removeStale).toBe(false);
    }
  });

});
