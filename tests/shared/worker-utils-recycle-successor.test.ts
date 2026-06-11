import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };

// After the hook POSTs /api/admin/restart the OLD worker spawns its own
// successor (src/services/worker-shutdown.ts; see
// plans/2026-06-10-worker-restart-single-source-of-truth.md). The hook must
// WAIT for that successor on /api/health instead of immediately lazy-spawning
// into the dying worker — lazy-spawn remains only as the safety net when no
// successor ever appears.

const PLUGIN_VERSION = '13.4.0';
const STALE_VERSION = '13.3.0';

// Record every HTTP call (same fetchLog pattern as
// tests/shared/worker-utils-version-recycle.test.ts).
const fetchLog: Array<{ url: string; method: string }> = [];

// Scripts the version /api/health reports per health call (0-based index).
// When the script array is exhausted the last entry repeats.
let healthVersionScript: string[] = [PLUGIN_VERSION];

// Records every spawn attempt — the seam the lazy-spawn fallback goes
// through (spawnHidden in src/shared/spawn.ts).
const spawnCalls: Array<{ command: string; args: string[] }> = [];

// The stale worker on the port: alive (health ok) and version-mismatched.
mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve({
    matches: false,
    pluginVersion: PLUGIN_VERSION,
    workerVersion: STALE_VERSION,
  }),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'alive',
}));

mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return { pid: 4242, unref: () => {} };
  },
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-recycle-successor=${Date.now()}-${Math.random()}`);
}

function installFetchMock(): void {
  fetchLog.length = 0;
  let healthCallIndex = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchLog.push({ url: u, method });

    let body: Record<string, unknown> = {};
    if (u.includes('/api/health')) {
      const version = healthVersionScript[Math.min(healthCallIndex, healthVersionScript.length - 1)];
      healthCallIndex++;
      body = { version };
    }

    // /api/readiness and /api/admin/restart answer plain 200 OK.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('ensureWorkerRunning — recycle waits for the dying worker\'s successor instead of spawning into the corpse', () => {
  const originalFetch = global.fetch;
  const originalReadinessBudget = process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;

  beforeEach(() => {
    // The lazy-spawn fallback now goes through the spawn gate
    // (src/shared/worker-spawn-gate.ts), which writes <DATA_DIR>/spawn.lock.
    // Point DATA_DIR at a temp dir so the test never touches the real
    // ~/.claude-mem lock (a live launcher's lock would make the fallback
    // SKIP its spawn and fail the expectation below).
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-recycle-successor-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    installFetchMock();
    spawnCalls.length = 0;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalReadinessBudget === undefined) {
      delete process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS;
    } else {
      process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = originalReadinessBudget;
    }
    if (originalDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
  });

  it('does NOT spawn when the successor appears on a later health poll', async () => {
    // Health call 0 = the initial isWorkerPortAlive probe (stale worker).
    // Call 1 = first successor poll, still the dying stale worker.
    // Call 2+ = the successor reports the plugin version.
    healthVersionScript = [STALE_VERSION, STALE_VERSION, PLUGIN_VERSION];
    // Generous budget — success arrives on poll 2 (~500ms in).
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '3000';

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    const result = await ensureWorkerRunning();

    expect(result).toBe(true);
    // The recycle was requested...
    const restartCalls = fetchLog.filter(
      c => c.url.includes('/api/admin/restart') && c.method === 'POST'
    );
    expect(restartCalls.length).toBe(1);
    // ...and NO spawn attempt raced the dying worker.
    expect(spawnCalls.length).toBe(0);
  });

  it('falls back to lazy-spawn when no successor ever appears within the budget', async () => {
    healthVersionScript = [STALE_VERSION]; // health never recovers to the plugin version
    // Small budget so the successor wait expires fast.
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '700';

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    const result = await ensureWorkerRunning();

    // The restart was still requested exactly once (one recycle per hook)...
    const restartCalls = fetchLog.filter(
      c => c.url.includes('/api/admin/restart') && c.method === 'POST'
    );
    expect(restartCalls.length).toBe(1);
    // ...and the safety-net lazy-spawn fired.
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toContain('--daemon');
    // The mocked port/readiness probes answer OK, so the hook proceeds.
    expect(result).toBe(true);
  });
});
