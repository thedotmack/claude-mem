import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { isWorkerFetchVerboseEnabled } from '../../src/shared/worker-utils.js';
// Freeze paths.ts on the preload data dir before any per-test env override.
import '../../src/shared/paths.js';

describe('isWorkerFetchVerboseEnabled', () => {
  it('stays off when unset, empty, or an explicit falsey value', () => {
    expect(isWorkerFetchVerboseEnabled({})).toBe(false);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: '' })).toBe(false);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: '0' })).toBe(false);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: 'false' })).toBe(false);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: 'off' })).toBe(false);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: 'no' })).toBe(false);
  });

  it('accepts 1/true/on/yes in any case', () => {
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: '1' })).toBe(true);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: 'true' })).toBe(true);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: 'TRUE' })).toBe(true);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: 'on' })).toBe(true);
    expect(isWorkerFetchVerboseEnabled({ CLAUDE_MEM_FETCH_VERBOSE: 'Yes' })).toBe(true);
  });
});

describe('worker-utils fetch verbose diagnostics', () => {
  const originalFetch = global.fetch;
  const originalVerbose = process.env.CLAUDE_MEM_FETCH_VERBOSE;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `worker-fetch-verbose-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    delete process.env.CLAUDE_MEM_FETCH_VERBOSE;
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
    global.fetch = originalFetch;
    if (originalVerbose === undefined) delete process.env.CLAUDE_MEM_FETCH_VERBOSE;
    else process.env.CLAUDE_MEM_FETCH_VERBOSE = originalVerbose;
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(): void {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  }

  it('does not pass verbose on fetchWithTimeout by default', async () => {
    const inits: Array<RequestInit & { verbose?: boolean }> = [];
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const workerUtils = await import('../../src/shared/worker-utils.js');
    await workerUtils.fetchWithTimeout('http://127.0.0.1:37777/api/health', { method: 'GET' }, 1000);

    expect(inits).toHaveLength(1);
    expect(inits[0].verbose).toBeUndefined();
    expect(inits[0].method).toBe('GET');
  });

  it('merges verbose:true into fetchWithTimeout when CLAUDE_MEM_FETCH_VERBOSE=1', async () => {
    process.env.CLAUDE_MEM_FETCH_VERBOSE = '1';
    const inits: Array<RequestInit & { verbose?: boolean }> = [];
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const workerUtils = await import('../../src/shared/worker-utils.js');
    await workerUtils.fetchWithTimeout('http://127.0.0.1:37777/api/health', { method: 'GET' }, 1000);

    expect(inits).toHaveLength(1);
    expect(inits[0].verbose).toBe(true);
    expect(inits[0].method).toBe('GET');
    expect(inits[0].signal).toBeDefined();
  });

  it('merges verbose:true into workerHttpRequest when the timeout path is skipped', async () => {
    process.env.CLAUDE_MEM_FETCH_VERBOSE = 'true';
    writeSettings();
    const inits: Array<RequestInit & { verbose?: boolean }> = [];
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();
    await workerUtils.workerHttpRequest('/api/health', { timeoutMs: 0 });

    expect(inits).toHaveLength(1);
    expect(inits[0].verbose).toBe(true);
  });

  it('does not pass verbose on workerHttpRequest when the flag is off', async () => {
    writeSettings();
    const inits: Array<RequestInit & { verbose?: boolean }> = [];
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();
    await workerUtils.workerHttpRequest('/api/health', { timeoutMs: 0 });

    expect(inits).toHaveLength(1);
    expect(inits[0].verbose).toBeUndefined();
  });

  it('rethrows fetch failures and still surfaces the cause when verbose is on', async () => {
    process.env.CLAUDE_MEM_FETCH_VERBOSE = '1';
    const cause = Object.assign(new Error('The socket connection was closed unexpectedly'), { code: 'UND_ERR_SOCKET' });
    const failure = new TypeError('fetch failed');
    failure.cause = cause;

    global.fetch = mock(() => Promise.reject(failure)) as unknown as typeof fetch;

    const workerUtils = await import('../../src/shared/worker-utils.js');
    await expect(workerUtils.fetchWithTimeout('http://127.0.0.1:37777/api/sessions/init', { method: 'POST' }, 1000))
      .rejects.toBe(failure);
  });
});
