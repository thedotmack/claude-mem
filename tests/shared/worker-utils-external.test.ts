import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Freeze paths.ts on the test runner's stable preload data directory before
// any per-test override. Cache-busted worker-utils imports otherwise evaluate
// paths.ts while CLAUDE_MEM_DATA_DIR points at a soon-deleted temp directory
// and can poison unrelated test files in the same Bun process.
import '../../src/shared/paths.js';

const originalFetch = global.fetch;
const originalEnv = {
  CLAUDE_MEM_DATA_DIR: process.env.CLAUDE_MEM_DATA_DIR,
  CLAUDE_MEM_EXTERNAL_WORKER: process.env.CLAUDE_MEM_EXTERNAL_WORKER,
  CLAUDE_MEM_WORKER_HOST: process.env.CLAUDE_MEM_WORKER_HOST,
  CLAUDE_MEM_WORKER_PORT: process.env.CLAUDE_MEM_WORKER_PORT,
  CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS: process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS,
};
const tempDirs: string[] = [];

function response(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response;
}

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?external-worker=${Date.now()}-${Math.random()}`);
}

function configureExternalMode(): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-external-worker-'));
  tempDirs.push(dataDir);
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  process.env.CLAUDE_MEM_EXTERNAL_WORKER = 'true';
  process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  process.env.CLAUDE_MEM_WORKER_PORT = '39991';
  process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '0';
}

afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mock.restore();
});

describe('ensureWorkerRunning external mode', () => {
  it('accepts the documented degraded health 503 when readiness is healthy', async () => {
    configureExternalMode();
    const calls: string[] = [];
    global.fetch = mock(async (url: string | URL | Request) => {
      const value = String(url);
      calls.push(value);
      return value.endsWith('/api/health') ? response(503) : response(200);
    }) as unknown as typeof fetch;

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    expect(await ensureWorkerRunning()).toBe(true);
    expect(calls.some(url => url.endsWith('/api/readiness'))).toBe(true);
  });

  it('still rejects a non-health error response', async () => {
    configureExternalMode();
    const calls: string[] = [];
    global.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      return response(500);
    }) as unknown as typeof fetch;

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    expect(await ensureWorkerRunning()).toBe(false);
    expect(calls.some(url => url.endsWith('/api/readiness'))).toBe(false);
  });
});
