/**
 * Tests for ensureWorkerRunning() retry logic.
 *
 * These tests mock global.fetch and PID file state.
 * Run standalone: bun test tests/shared/worker-utils-retry.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { ensureWorkerRunning } from '../../src/shared/worker-utils.js';
import { logger } from '../../src/utils/logger.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

describe('ensureWorkerRunning retry logic', () => {
  const originalFetch = global.fetch;
  let savedPidContent: string | null = null;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeAll(() => {
    // Save PID file once for entire suite
    try {
      if (existsSync(PID_FILE)) {
        savedPidContent = readFileSync(PID_FILE, 'utf-8');
      }
    } catch { /* ignore */ }
  });

  afterAll(() => {
    // Restore global state
    global.fetch = originalFetch;
    try {
      if (savedPidContent !== null) {
        writeFileSync(PID_FILE, savedPidContent);
      }
    } catch { /* ignore */ }
  });

  beforeEach(() => {
    // Suppress logger output
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    // Always restore fetch immediately after each test
    global.fetch = originalFetch;
    loggerSpies.forEach(spy => spy.mockRestore());
    // Restore PID file state between tests
    try {
      if (savedPidContent !== null) {
        writeFileSync(PID_FILE, savedPidContent);
      } else if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
      }
    } catch { /* ignore */ }
  });

  it('should return true on first health check success', async () => {
    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: '0.0.0-test' }),
      text: () => Promise.resolve('OK'),
    } as unknown as Response));

    const result = await ensureWorkerRunning();
    expect(result).toBe(true);
  });

  it('should return false when health fails and no recent PID file', async () => {
    // Remove PID file to simulate "worker needs spawn"
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch { /* ignore */ }

    global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

    const result = await ensureWorkerRunning();
    expect(result).toBe(false);
  });

  it('should retry when PID file is recent and health check eventually succeeds', async () => {
    // Create a fresh PID file (simulates worker starting up)
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() }));

    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: '0.0.0-test' }),
        text: () => Promise.resolve('OK'),
      } as unknown as Response);
    });

    const result = await ensureWorkerRunning();
    expect(result).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('should not exceed timeout budget when retrying', async () => {
    // Create a fresh PID file
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() }));

    global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

    const startTime = Date.now();
    const result = await ensureWorkerRunning();
    const elapsed = Date.now() - startTime;

    expect(result).toBe(false);
    // Should not exceed the health check timeout budget (default 3s + tolerance)
    expect(elapsed).toBeLessThan(6000);
  });
});
