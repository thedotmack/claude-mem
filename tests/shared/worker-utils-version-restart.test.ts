/**
 * Worker Auto-Restart on Version Mismatch Tests
 *
 * Tests for the version-mismatch restart behaviour added to ensureWorkerRunning().
 *
 * Test scenarios:
 * 1. Healthy worker, versions match          -> no restart, returns true
 * 2. Healthy worker, mismatch, restart OK    -> restart called, returns true
 * 3. Healthy worker, mismatch, restart fails -> restart called, returns false
 * 4. Healthy worker, version check throws    -> returns true (graceful)
 * 5. Unhealthy worker                        -> returns false, no version/restart
 * 6. Mismatch, restart OK but post-health fails -> returns false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks – declared before any imports that transitively use them
// ---------------------------------------------------------------------------

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock logger so tests stay silent
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock SettingsDefaultsManager to avoid real settings file access
vi.mock('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: vi.fn().mockReturnValue('37777'),
    getInt: vi.fn().mockReturnValue(37777),
    getBool: vi.fn().mockReturnValue(false),
    getAllDefaults: vi.fn().mockReturnValue({}),
    loadFromFile: vi.fn().mockReturnValue({ MAGIC_CLAUDE_MEM_WORKER_PORT: '37777', MAGIC_CLAUDE_MEM_WORKER_HOST: '127.0.0.1' }),
  },
}));

// ---------------------------------------------------------------------------
// Deferred imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { ensureWorkerRunning, clearPortCache } from '../../src/shared/worker-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_VERSION = '9.4.0';
const OUTDATED_WORKER_VERSION = '9.3.0';

/** Make global fetch return a health-ok response */
function mockHealthy(): void {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: PLUGIN_VERSION }) });
}

/** Make global fetch return a health-ok response but with a mismatched worker version */
function mockHealthyWithMismatch(): void {
  global.fetch = vi.fn()
    .mockImplementation((url: string) => {
      if (String(url).includes('/api/health')) {
        return Promise.resolve({ ok: true });
      }
      if (String(url).includes('/api/version')) {
        return Promise.resolve({ ok: true, json: async () => ({ version: OUTDATED_WORKER_VERSION }) });
      }
      return Promise.resolve({ ok: false });
    });
}

/** Make global fetch return a health-fail response */
function mockUnhealthy(): void {
  global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
}

/** Make readFileSync return a package.json with the given version */
function mockPackageJson(version: string): void {
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version }));
}

/** Mock execFile to invoke its callback with the given error (null for success) */
function mockExecFile(error: Error | null = null): void {
  vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, callback) => {
    if (typeof callback === 'function') {
      callback(error, '', '');
    } else if (typeof _opts === 'function') {
      _opts(error, '', '');
    }
    return {} as ReturnType<typeof execFile>;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureWorkerRunning – version mismatch restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when worker is healthy and versions match (no restart triggered)', async () => {
    mockPackageJson(PLUGIN_VERSION);
    mockHealthy();

    const result = await ensureWorkerRunning();

    expect(result).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns true when worker is healthy, versions mismatch, and restart succeeds', async () => {
    mockPackageJson(PLUGIN_VERSION);
    mockExecFile();

    // Sequential fetch responses: health OK → version mismatch → post-restart health OK
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: true }))                             // initial health
      .mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => ({ version: OUTDATED_WORKER_VERSION }) })) // version check
      .mockImplementationOnce(() => Promise.resolve({ ok: true }));                            // post-restart health
    global.fetch = fetchMock;

    const result = await ensureWorkerRunning();

    expect(result).toBe(true);
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('returns false when worker is healthy, versions mismatch, and restart fails', async () => {
    mockPackageJson(PLUGIN_VERSION);
    mockHealthyWithMismatch();
    mockExecFile(new Error('restart failed'));

    const result = await ensureWorkerRunning();

    expect(result).toBe(false);
    expect(execFile).toHaveBeenCalledOnce();
    // Only health + version fetches; no post-restart health because execFile errored
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns true when version check throws (graceful degradation – assume OK)', async () => {
    mockPackageJson(PLUGIN_VERSION);

    // Health OK, but version endpoint throws
    global.fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: true }))  // health check
      .mockImplementationOnce(() => Promise.reject(new Error('network error'))); // version check fails

    const result = await ensureWorkerRunning();

    expect(result).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns false and skips version check when worker is unhealthy', async () => {
    mockPackageJson(PLUGIN_VERSION);
    mockUnhealthy();

    const result = await ensureWorkerRunning();

    expect(result).toBe(false);
    // fetch was only called for health (and threw); version endpoint must not have been called
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns false when mismatch restart succeeds but post-restart health check fails', async () => {
    mockPackageJson(PLUGIN_VERSION);
    mockExecFile();

    global.fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: true }))                                       // initial health
      .mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => ({ version: OUTDATED_WORKER_VERSION }) })) // version check
      .mockImplementationOnce(() => Promise.resolve({ ok: false }));                                     // post-restart health FAIL

    const result = await ensureWorkerRunning();

    expect(result).toBe(false);
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('clears port cache after restart so health check re-reads settings', async () => {
    mockPackageJson(PLUGIN_VERSION);
    mockExecFile();

    // Reset cache so getWorkerPort() will read from SettingsDefaultsManager
    clearPortCache();

    const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
    vi.mocked(SettingsDefaultsManager.loadFromFile).mockClear();

    // Sequential fetch: health OK → version mismatch → post-restart health OK
    global.fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: true }))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => ({ version: OUTDATED_WORKER_VERSION }) }))
      .mockImplementationOnce(() => Promise.resolve({ ok: true }));

    await ensureWorkerRunning();

    // getWorkerPort() reads from SettingsDefaultsManager.loadFromFile on cache miss.
    // If clearPortCache() is called after restart, loadFromFile is called again
    // for the post-restart health check (at least 2 calls total).
    // Without clearPortCache(), the cached port persists and loadFromFile is called only once.
    expect(vi.mocked(SettingsDefaultsManager.loadFromFile).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
