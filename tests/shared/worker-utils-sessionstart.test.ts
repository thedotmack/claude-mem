import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realSpawn from '../../src/shared/spawn.js';
import * as realPaths from '../../src/shared/paths.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realOauthToken from '../../src/shared/oauth-token.js';
import * as realPlatformSource from '../../src/shared/platform-source.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realProcessManagerSnapshot = { ...realProcessManager };
const realSpawnSnapshot = { ...realSpawn };
const realPathsSnapshot = { ...realPaths };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realProjectNameSnapshot = { ...realProjectName };
const realHookSettingsSnapshot = { ...realHookSettings };
const realOauthTokenSnapshot = { ...realOauthToken };
const realPlatformSourceSnapshot = { ...realPlatformSource };

const fetchLog: Array<{ url: string; method: string }> = [];
let spawnCalls = 0;
let healthFailuresBeforeSuccess = 0;

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve({
    matches: true,
    pluginVersion: '13.6.0',
    workerVersion: '13.6.0',
  }),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'missing',
}));

mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  resolveWorkerRuntimePath: () => 'C:\\bun\\bin\\bun.exe',
}));

mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: () => {
    spawnCalls += 1;
    return { unref() {} };
  },
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-sessionstart=${Date.now()}-${Math.random()}`);
}

async function importContextHandlerFresh() {
  return import(`../../src/cli/handlers/context.js?worker-utils-sessionstart=${Date.now()}-${Math.random()}`);
}

function installWorkerFetchMock(): void {
  fetchLog.length = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchLog.push({ url: requestUrl, method });

    if (requestUrl.includes('/api/readiness')) {
      return Promise.resolve(new Response('', { status: 200 }));
    }

    if (requestUrl.includes('/api/health')) {
      if (healthFailuresBeforeSuccess > 0) {
        healthFailuresBeforeSuccess -= 1;
        return Promise.resolve(new Response('', { status: 503 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ version: '13.6.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    return Promise.resolve(new Response('', { status: 200 }));
  }) as unknown as typeof fetch;
}

describe('worker-utils SessionStart best-effort startup', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;

  beforeEach(() => {
    spawnCalls = 0;
    healthFailuresBeforeSuccess = 0;
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-worker-utils-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    mock.module('../../src/shared/paths.js', () => ({
      ...realPathsSnapshot,
      DATA_DIR: tempDataDir,
    }));
    installWorkerFetchMock();
  });

  afterEach(() => {
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
    mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
    mock.module('../../src/shared/paths.js', () => realPathsSnapshot);
  });

  it('skips lazy-spawn when a SessionStart caller opts into best-effort startup', async () => {
    healthFailuresBeforeSuccess = 1;

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    const ready = await ensureWorkerRunning({ allowLazySpawn: false });

    expect(ready).toBe(false);
    expect(spawnCalls).toBe(0);
    expect(fetchLog.filter(call => call.url.includes('/api/health'))).toHaveLength(1);
    expect(fetchLog.some(call => call.url.includes('/api/readiness'))).toBe(false);
  });

  it('still lazy-spawns and waits for readiness on the default path', async () => {
    healthFailuresBeforeSuccess = 2;

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    const ready = await ensureWorkerRunning();

    expect(ready).toBe(true);
    expect(spawnCalls).toBe(1);
    expect(fetchLog.filter(call => call.url.includes('/api/health')).length).toBeGreaterThanOrEqual(3);
    expect(fetchLog.some(call => call.url.includes('/api/readiness'))).toBe(true);
  });

  it('does not persist a fail-loud worker-unreachable streak for best-effort SessionStart calls', async () => {
    healthFailuresBeforeSuccess = 1;

    const { executeWithWorkerFallback, isWorkerFallback } = await importWorkerUtilsFresh();
    const result = await executeWithWorkerFallback('/api/context/inject?projects=test-project', 'GET', undefined, {
      allowLazySpawn: false,
    });

    expect(isWorkerFallback(result)).toBe(true);
    const failureStatePath = join(tempDataDir, 'state', 'hook-failures.json');
    expect(existsSync(failureStatePath)).toBe(false);
  });

  it('still persists the fail-loud worker-unreachable streak on the normal failure path', async () => {
    const { recordWorkerUnreachable } = await importWorkerUtilsFresh();
    await recordWorkerUnreachable();

    const failureStatePath = join(tempDataDir, 'state', 'hook-failures.json');
    expect(existsSync(failureStatePath)).toBe(true);
    expect(JSON.parse(readFileSync(failureStatePath, 'utf-8'))).toMatchObject({
      consecutiveFailures: 1,
    });
  });
});

describe('contextHandler SessionStart integration', () => {
  const originalFetch = global.fetch;
  const executeCalls: Array<{
    url: string;
    method: string;
    body: unknown;
    options: Record<string, unknown>;
  }> = [];

  beforeEach(() => {
    executeCalls.length = 0;
    global.fetch = originalFetch;
    mock.module('../../src/shared/worker-utils.js', () => ({
      executeWithWorkerFallback: (
        url: string,
        method: string,
        body?: unknown,
        options: Record<string, unknown> = {}
      ) => {
        executeCalls.push({ url, method, body, options });
        return Promise.resolve({
          continue: true,
          reason: 'worker_unreachable',
          __testFallback: true,
        });
      },
      isWorkerFallback: (result: unknown) => typeof result === 'object'
        && result !== null
        && (result as Record<string, unknown>).reason === 'worker_unreachable',
      getWorkerPort: () => 37777,
    }));
    mock.module('../../src/utils/project-name.js', () => ({
      getProjectContext: () => ({ allProjects: ['test-project'] }),
    }));
    mock.module('../../src/shared/hook-settings.js', () => ({
      loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' }),
    }));
    mock.module('../../src/shared/oauth-token.js', () => ({
      readStaleMarker: () => null,
    }));
    mock.module('../../src/shared/platform-source.js', () => ({
      normalizePlatformSource: (platform: string) => platform,
    }));
    mock.module('../../src/shared/mcp-client.js', () => ({
      callMcpToolOnce: () => Promise.resolve({ isError: false, text: '' }),
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
    mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
    mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
    mock.module('../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
    mock.module('../../src/shared/platform-source.js', () => realPlatformSourceSnapshot);
  });

  it('requests SessionStart context with non-blocking worker fallback and returns the empty hook payload', async () => {
    const { contextHandler } = await importContextHandlerFresh();
    const result = await contextHandler.execute({
      cwd: 'D:\\Repos\\claude-mem-pr-2903-vscode-init-deadline',
      platform: 'claude-code',
    });

    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toMatchObject({
      url: '/api/context/inject?projects=test-project&platformSource=claude-code',
      method: 'GET',
      body: undefined,
      options: { allowLazySpawn: false },
    });
    expect(result).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      exitCode: 0,
    });
  });

  it('keeps the color timeline fetch on the same non-blocking path', async () => {
    mock.module('../../src/shared/worker-utils.js', () => ({
      executeWithWorkerFallback: (
        url: string,
        method: string,
        body?: unknown,
        options: Record<string, unknown> = {}
      ) => {
        executeCalls.push({ url, method, body, options });
        return Promise.resolve(executeCalls.length === 1 ? 'context body' : 'colored body');
      },
      isWorkerFallback: () => false,
      getWorkerPort: () => 37777,
    }));
    mock.module('../../src/shared/hook-settings.js', () => ({
      loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true' }),
    }));

    const { contextHandler } = await importContextHandlerFresh();
    const result = await contextHandler.execute({
      cwd: 'D:\\Repos\\claude-mem-pr-2903-vscode-init-deadline',
      platform: 'claude-code',
    });

    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0]).toMatchObject({
      url: '/api/context/inject?projects=test-project&platformSource=claude-code',
      method: 'GET',
      body: undefined,
      options: { allowLazySpawn: false },
    });
    expect(executeCalls[1]).toMatchObject({
      url: '/api/context/inject?projects=test-project&platformSource=claude-code&colors=true',
      options: { allowLazySpawn: false },
    });
    expect(result.systemMessage).toContain('colored body');
  });
});
