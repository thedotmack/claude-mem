/**
 * Tests for fetchWithTimeout() timer cleanup behavior.
 *
 * Validates that:
 * - Timeouts fire correctly on slow requests
 * - Timer references are cleaned up on success (no leaks)
 * - Timer references are cleaned up on failure (no leaks)
 *
 * Run standalone: bun test tests/shared/fetch-with-timeout.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { fetchWithTimeout } from '../../src/shared/worker-utils.js';

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should resolve with response on successful fetch within timeout', async () => {
    const mockResponse = { ok: true, status: 200 } as Response;
    global.fetch = mock(() => Promise.resolve(mockResponse));

    const result = await fetchWithTimeout('http://localhost:37777/api/health', {}, 5000);
    expect(result).toBe(mockResponse);
  });

  it('should reject with timeout error when fetch exceeds timeout', async () => {
    // Fetch that never resolves
    global.fetch = mock(() => new Promise(() => {}));

    await expect(
      fetchWithTimeout('http://localhost:37777/api/health', {}, 50)
    ).rejects.toThrow('Request timed out after 50ms');
  });

  it('should reject with fetch error when fetch fails within timeout', async () => {
    global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

    await expect(
      fetchWithTimeout('http://localhost:37777/api/health', {}, 5000)
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('should clear timeout on successful fetch (no leaked timers)', async () => {
    const clearTimeoutSpy = spyOn(global, 'clearTimeout');
    const mockResponse = { ok: true, status: 200 } as Response;
    global.fetch = mock(() => Promise.resolve(mockResponse));

    await fetchWithTimeout('http://localhost:37777/api/health', {}, 5000);

    // clearTimeout should have been called exactly once (the success path clears the timer)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  it('should clear timeout on failed fetch (no leaked timers)', async () => {
    const clearTimeoutSpy = spyOn(global, 'clearTimeout');
    global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

    try {
      await fetchWithTimeout('http://localhost:37777/api/health', {}, 5000);
    } catch {
      // Expected
    }

    // clearTimeout should have been called exactly once (the error path clears the timer)
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  it('should pass request init options to fetch', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test": true}',
    };

    await fetchWithTimeout('http://localhost:37777/api/test', init, 5000);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:37777/api/test', init);
  });
});
