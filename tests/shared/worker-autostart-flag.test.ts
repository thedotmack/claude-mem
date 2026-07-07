import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realCliTelemetry from '../../src/services/telemetry/cli-telemetry.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realSupervisorSnapshot = { ...realSupervisor };
const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realCliTelemetrySnapshot = { ...realCliTelemetry };

let settings: Record<string, string> = {};
const fetchLog: Array<{ url: string; method: string }> = [];
const dataDir = path.join(tmpdir(), `claude-mem-worker-utils-${Date.now()}-${Math.random().toString(36).slice(2)}`);

mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => settings,
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: (options: { pidFilePath?: string } = {}) => {
    if (!options.pidFilePath) return 'alive';
    if (!existsSync(options.pidFilePath)) return 'missing';
    try {
      const pidInfo = JSON.parse(readFileSync(options.pidFilePath, 'utf-8')) as { pid?: unknown };
      if (typeof pidInfo.pid === 'number' && Number.isInteger(pidInfo.pid) && pidInfo.pid > 0) {
        return 'alive';
      }
    } catch {
      rmSync(options.pidFilePath, { force: true });
      return 'invalid';
    }
    rmSync(options.pidFilePath, { force: true });
    return 'stale';
  },
  getSupervisor: () => ({
    assertCanSpawn: () => {},
    registerProcess: () => {},
    unregisterProcess: () => {},
    getRegistry: () => ({ reapSession: () => {} }),
    stop: () => Promise.resolve(),
  }),
}));

mock.module('../../src/services/infrastructure/HealthMonitor.js', () => ({
  checkVersionMatch: () =>
    Promise.resolve({ matches: true, pluginVersion: '13.4.1', workerVersion: '13.4.1' }),
}));

mock.module('../../src/services/telemetry/cli-telemetry.js', () => ({
  captureCliEvent: () => Promise.resolve(),
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-autostart=${Date.now()}-${Math.random()}`);
}

function installFetchMock(): void {
  fetchLog.length = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    fetchLog.push({
      url: typeof url === 'string' ? url : url.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ version: '13.4.1' }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('worker autostart and fail-loud warning behavior', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    settings = {};
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    installFetchMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CLAUDE_MEM_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
    mock.module('../../src/services/telemetry/cli-telemetry.js', () => realCliTelemetrySnapshot);
  });

  it('returns false without contacting the worker when CLAUDE_MEM_WORKER_AUTOSTART=false', async () => {
    settings = { CLAUDE_MEM_WORKER_AUTOSTART: 'false' };

    const { ensureWorkerAliveOnce } = await importWorkerUtilsFresh();

    expect(await ensureWorkerAliveOnce()).toBe(false);
    expect(fetchLog).toHaveLength(0);
  });

  it('uses the existing worker path when autostart is unset', async () => {
    const { ensureWorkerAliveOnce } = await importWorkerUtilsFresh();

    expect(await ensureWorkerAliveOnce()).toBe(true);
    expect(fetchLog.some(call => call.url.includes('/api/health'))).toBe(true);
  });

  it('warns but does not throw or exit for Kiro when the worker-unreachable threshold is reached', async () => {
    settings = { CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '1' };

    const { recordWorkerUnreachable, setActivePlatform } = await importWorkerUtilsFresh();
    setActivePlatform('kiro');

    expect(await recordWorkerUnreachable()).toBe(1);
  });
});
