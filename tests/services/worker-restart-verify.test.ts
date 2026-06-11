import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { verifyRestartedWorker, getCurrentWorkerPid } from '../../src/services/restart-verify.js';

// verifyRestartedWorker lives in src/services/restart-verify.ts (not
// worker-service.ts) precisely so this test can import it without triggering
// worker-service.ts's top-level side effects (isMainModule bootstrap, bun:sqlite,
// MCP SDK, telemetry).

const EXPECTED_VERSION = '13.5.5-test';
const OLD_PID = 11111;
const NEW_PID = 22222;
const PORT = 45678; // arbitrary; port is always injected, never resolved here

// Record every HTTP call the verifier makes (same fetchLog pattern as
// tests/shared/worker-utils-version-recycle.test.ts).
const fetchLog: Array<{ url: string; method: string }> = [];

// Each test sets this to script what /api/health reports per call.
// 'unreachable' rejects the fetch like a connection refusal. The
// `{ status, body }` form scripts a non-200 response (e.g. 503 degraded).
let healthResponder: (callIndex: number) =>
  | { pid?: number; version?: string }
  | { status: number; body: { pid?: number; version?: string } }
  | 'unreachable';

function installFetchMock(): void {
  fetchLog.length = 0;
  let callIndex = 0;
  global.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchLog.push({ url: u, method });

    const scripted = healthResponder(callIndex++);
    if (scripted === 'unreachable') {
      return Promise.reject(new Error('connect ECONNREFUSED'));
    }
    const status = 'body' in scripted ? scripted.status : 200;
    const body = 'body' in scripted ? scripted.body : scripted;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

// Short injectable deadline + poll interval so every test completes fast.
const FAST = { pollIntervalMs: 10, requestTimeoutMs: 100 };
const DEADLINE_MS = 300;

describe('verifyRestartedWorker — restart must prove itself', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('succeeds when health flips to the new pid with the expected version', async () => {
    // First poll still sees the old worker, then the new one comes up.
    healthResponder = i =>
      i === 0
        ? { pid: OLD_PID, version: EXPECTED_VERSION }
        : { pid: NEW_PID, version: EXPECTED_VERSION };

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(NEW_PID);
      expect(result.version).toBe(EXPECTED_VERSION);
    }
    // It polled /api/health (only pid + version are read — no /api/version).
    expect(fetchLog.length).toBeGreaterThanOrEqual(2);
    expect(fetchLog.every(c => c.url.includes('/api/health') && c.method === 'GET')).toBe(true);
  });

  it('succeeds when health answers 503 (degraded) but reports the new pid and expected version', async () => {
    // /api/health returns 503 when the queue is degraded but still includes
    // pid/version — a degraded-but-booted worker still proves the restart.
    healthResponder = () => ({ status: 503, body: { pid: NEW_PID, version: EXPECTED_VERSION } });

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(NEW_PID);
      expect(result.version).toBe(EXPECTED_VERSION);
    }
  });

  it('succeeds on version alone when no previous worker existed (oldPid null)', async () => {
    // getCurrentWorkerPid returned null (nothing was listening before the
    // restart), so any pid counts — verification only requires the version.
    healthResponder = () => ({ pid: NEW_PID, version: EXPECTED_VERSION });

    const result = await verifyRestartedWorker(PORT, null, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(NEW_PID);
      expect(result.version).toBe(EXPECTED_VERSION);
    }
  });

  it('fails when health keeps returning the stale (old) pid', async () => {
    healthResponder = () => ({ pid: OLD_PID, version: EXPECTED_VERSION });

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastObserved).toContain(String(OLD_PID));
      // A live (stale) worker is serving — callers skip the port-free wait.
      expect(result.lastPollSawHealth).toBe(true);
    }
  });

  it('fails when the new worker reports the wrong version', async () => {
    healthResponder = () => ({ pid: NEW_PID, version: '0.0.1-stale' });

    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastObserved).toContain('0.0.1-stale');
      // A live (wrong-version) worker is serving — callers skip the port-free wait.
      expect(result.lastPollSawHealth).toBe(true);
    }
  });

  it('fails on timeout when health is unreachable, reporting the connection error', async () => {
    healthResponder = () => 'unreachable';

    const start = Date.now();
    const result = await verifyRestartedWorker(PORT, OLD_PID, EXPECTED_VERSION, DEADLINE_MS, FAST);
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastObserved).toContain('connection error');
      expect(result.lastObserved).toContain('ECONNREFUSED');
      // Nothing is serving on the port — callers may wait for it to free.
      expect(result.lastPollSawHealth).toBe(false);
    }
    // Hard cap: the deadline bounds the wait (generous slack for CI).
    expect(elapsed).toBeLessThan(DEADLINE_MS + 1000);
  });
});

describe('getCurrentWorkerPid — old-pid capture before shutdown', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the running worker pid from /api/health', async () => {
    healthResponder = () => ({ pid: OLD_PID, version: EXPECTED_VERSION });
    expect(await getCurrentWorkerPid(PORT, 100)).toBe(OLD_PID);
  });

  it('returns null when no worker is reachable', async () => {
    healthResponder = () => 'unreachable';
    expect(await getCurrentWorkerPid(PORT, 100)).toBeNull();
  });
});
