import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';
import { logger } from '../../src/utils/logger.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };

// On version mismatch the hook must NOT delegate the recycle to the running
// worker (the old design POSTed /api/admin/restart and the dying worker
// spawned its own successor — but that handoff runs the STALE install's
// resolver, so a ≤13.11.0 worker respawns its own version forever, #3378).
// The hook SIGKILLs the stale worker itself and lazy-spawns the resolved
// script.

const PLUGIN_VERSION = '13.4.0';
const STALE_VERSION = '13.3.0';
const STALE_PID = 4242;

// Record every HTTP call so we can assert no /api/admin/restart is issued.
const fetchLog: Array<{ url: string; method: string }> = [];

// Controls what checkVersionMatch reports for a given test.
let versionMatchResult: { matches: boolean; pluginVersion: string; workerVersion: string | null } = {
  matches: true,
  pluginVersion: PLUGIN_VERSION,
  workerVersion: PLUGIN_VERSION,
};

// What the supervisor's PID-file reader reports (null = unidentifiable).
let ownedPidInfo: { pid: number; port: number; startedAt: string } | null = null;

// Simulated process states driving the fetch mock: the stale worker serves
// the port until it is killed; the successor serves it after spawnHidden.
let staleWorkerAlive = true;
let successorUp = false;

// /api/health.workerPath. Null = older workers that omit the field (still
// SIGKILL on mismatch — #3378). Set to the resolved current script to
// reproduce #3857 (newest file already running, stale baked version).
let healthWorkerPath: string | null = null;

const OLD_WORKER_PATH = '/old/cache/13.23.1/scripts/worker-service.cjs';

// Records every spawn attempt (the lazy-spawn seam, spawnHidden in spawn.ts).
const spawnCalls: Array<{ command: string; args: string[] }> = [];

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve(versionMatchResult),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'alive',
  readOwnedWorkerPidInfo: () => ownedPidInfo,
}));

mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    successorUp = true;
    return { pid: 5151, unref: () => {} };
  },
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-version-recycle=${Date.now()}-${Math.random()}`);
}

function okResponse(body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function installFetchMock(): void {
  fetchLog.length = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchLog.push({ url: u, method });

    const portServed = staleWorkerAlive || successorUp;
    if (!portServed) {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1'));
    }
    if (u.includes('/api/health')) {
      return okResponse({
        version: versionMatchResult.workerVersion,
        ...(healthWorkerPath ? { workerPath: healthWorkerPath } : {}),
      });
    }
    return okResponse({});
  }) as unknown as typeof fetch;
}

describe('ensureWorkerRunning — stale-worker recycle on version mismatch', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;
  let killSpy: ReturnType<typeof spyOn>;
  let killCalls: Array<{ pid: number; signal: string | number | undefined }>;
  let killError: NodeJS.ErrnoException | null;

  beforeEach(() => {
    // The lazy-spawn goes through the spawn gate (worker-spawn-gate.ts),
    // which writes <DATA_DIR>/spawn.lock — point DATA_DIR at a temp dir so
    // the test never touches the real ~/.claude-mem lock.
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-version-recycle-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    installFetchMock();
    spawnCalls.length = 0;
    staleWorkerAlive = true;
    successorUp = false;
    healthWorkerPath = null;
    ownedPidInfo = null;
    killCalls = [];
    killError = null;
    killSpy = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      staleWorkerAlive = false;
      if (killError !== null) throw killError;
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    global.fetch = originalFetch;
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

  it('SIGKILLs the stale worker and lazy-spawns the resolved script — never POSTs /api/admin/restart', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
    expect(killCalls).toEqual([{ pid: STALE_PID, signal: 'SIGKILL' }]);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toContain('--daemon');
    const restartCalls = fetchLog.filter(c => c.url.includes('/api/admin/restart'));
    expect(restartCalls.length).toBe(0);
  });

  it('does NOT kill or spawn when versions match', async () => {
    versionMatchResult = { matches: true, pluginVersion: PLUGIN_VERSION, workerVersion: PLUGIN_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
    expect(killCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
    const restartCalls = fetchLog.filter(c => c.url.includes('/api/admin/restart'));
    expect(restartCalls.length).toBe(0);
  });

  it('returns false without killing anything when the PID file does not identify the stale worker', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    ownedPidInfo = null;

    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(false);
    expect(killCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });

  it('does not SIGKILL across hook events when the current plugin path is already running with a stale baked version', async () => {
    // #3857 — cache folder named 13.24.0, /api/health still reports 13.23.1.
    // Killing respawns the same file. Leave it up; log once for the pair.
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    const currentPath = workerUtils.resolveWorkerScriptPath();
    expect(currentPath).toBeTruthy();
    healthWorkerPath = currentPath;
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };

    const warnSpy = spyOn(logger, 'warn');
    try {
      const first = await workerUtils.ensureWorkerRunning();
      expect(first).toBe(true);
      expect(killCalls.length).toBe(0);
      expect(spawnCalls.length).toBe(0);

      const workerUtils2 = await importWorkerUtilsFresh();
      const second = await workerUtils2.ensureWorkerRunning();
      expect(second).toBe(true);
      expect(killCalls.length).toBe(0);
      expect(spawnCalls.length).toBe(0);

      const staleWarns = warnSpy.mock.calls.filter((call) =>
        String(call[1]).includes('stale version')
      );
      expect(staleWarns.length).toBe(1);

      const restartCalls = fetchLog.filter(c => c.url.includes('/api/admin/restart'));
      expect(restartCalls.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still SIGKILLs an old-path stale worker once, then does not kill the current-path successor', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    healthWorkerPath = OLD_WORKER_PATH;

    const workerUtils = await importWorkerUtilsFresh();
    const currentPath = workerUtils.resolveWorkerScriptPath();
    expect(currentPath).toBeTruthy();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };

    const first = await workerUtils.ensureWorkerRunning();
    expect(first).toBe(true);
    expect(killCalls).toEqual([{ pid: STALE_PID, signal: 'SIGKILL' }]);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toContain(currentPath!);
    expect(spawnCalls[0].args).toContain('--daemon');
    expect(fetchLog.filter(c => c.url.includes('/api/admin/restart')).length).toBe(0);

    // Successor is the current file and still reports the stale bake.
    healthWorkerPath = currentPath;
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    staleWorkerAlive = false;
    successorUp = true;

    const workerUtils2 = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: 5151, port: workerUtils2.getWorkerPort(), startedAt: new Date().toISOString() };
    const second = await workerUtils2.ensureWorkerRunning();
    expect(second).toBe(true);
    expect(killCalls.length).toBe(1);
    expect(spawnCalls.length).toBe(1);
    expect(fetchLog.filter(c => c.url.includes('/api/admin/restart')).length).toBe(0);
  });

  it('does not treat a blank persisted workerPath as the current script path', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    const currentPath = workerUtils.resolveWorkerScriptPath();
    expect(currentPath).toBeTruthy();
    healthWorkerPath = currentPath;
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };

    mkdirSync(join(tempDataDir, 'state'), { recursive: true });
    writeFileSync(
      join(tempDataDir, 'state', 'version-mismatch-warn.json'),
      JSON.stringify({
        workerPath: '   ',
        workerVersion: STALE_VERSION,
        pluginVersion: PLUGIN_VERSION,
      }),
      'utf-8'
    );

    const warnSpy = spyOn(logger, 'warn');
    try {
      const result = await workerUtils.ensureWorkerRunning();
      expect(result).toBe(true);
      expect(killCalls.length).toBe(0);
      const staleWarns = warnSpy.mock.calls.filter((call) =>
        String(call[1]).includes('stale version')
      );
      expect(staleWarns.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps version-mismatch warn state valid JSON when two hook processes persist concurrently', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };

    const workerUtils = await importWorkerUtilsFresh();
    const currentPath = workerUtils.resolveWorkerScriptPath();
    expect(currentPath).toBeTruthy();
    healthWorkerPath = currentPath;
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };

    const workerUtils2 = await importWorkerUtilsFresh();
    await Promise.all([
      workerUtils.ensureWorkerRunning(),
      workerUtils2.ensureWorkerRunning(),
    ]);

    const persistPath = join(tempDataDir, 'state', 'version-mismatch-warn.json');
    const parsed = JSON.parse(readFileSync(persistPath, 'utf-8')) as {
      workerPath: string;
      workerVersion: string;
      pluginVersion: string;
    };
    expect(parsed.workerVersion).toBe(STALE_VERSION);
    expect(parsed.pluginVersion).toBe(PLUGIN_VERSION);
    expect(parsed.workerPath.trim()).not.toBe('');
    expect(killCalls.length).toBe(0);
  });

  it('proceeds to lazy-spawn when the stale worker already exited (ESRCH on kill)', async () => {
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    const esrch: NodeJS.ErrnoException = new Error('kill ESRCH');
    esrch.code = 'ESRCH';
    killError = esrch;

    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
    expect(spawnCalls.length).toBe(1);
  });
});
