import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import net from 'net';
import {
  isPortInUse,
  waitForHealth,
  waitForPortFree,
  getInstalledPluginVersion,
  checkVersionMatch
} from '../../src/services/infrastructure/index.js';

describe('HealthMonitor', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('isPortInUse', () => {
    // Note: Since we are on Linux (as per session_context), isPortInUse uses 'net'
    // instead of 'fetch'. We need to mock 'net.createServer().listen()'

    it('should return true for occupied port (EADDRINUSE)', async () => {
      // Create a specific mock for this test
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') {
            // Trigger EADDRINUSE immediately
            setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
          }
        }),
        listen: mock(() => {})
      }));
      
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(37777);

      expect(result).toBe(true);
      expect(net.createServer).toHaveBeenCalled();
      
      spy.mockRestore();
    });

    it('should return false for free port (listening succeeds)', async () => {
      const closeMock = mock((cb: Function) => cb());
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'listening') {
            // Trigger listening success
            setTimeout(() => cb(), 0);
          }
        }),
        listen: mock(() => {}),
        close: closeMock
      }));
      
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(39999);

      expect(result).toBe(false);
      expect(net.createServer).toHaveBeenCalled();
      expect(closeMock).toHaveBeenCalled();
      
      spy.mockRestore();
    });

    it('should return false for other socket errors', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') {
            // Trigger other error (e.g., EACCES)
            setTimeout(() => cb({ code: 'EACCES' }), 0);
          }
        }),
        listen: mock(() => {})
      }));
      
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(37777);

      expect(result).toBe(false);
      
      spy.mockRestore();
    });
  });

  describe('waitForHealth', () => {
    it('should succeed immediately when server responds', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));

      const start = Date.now();
      const result = await waitForHealth(37777, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      // Should return quickly (within first poll cycle)
      expect(elapsed).toBeLessThan(1000);
    });

    it('should timeout when no server responds', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const start = Date.now();
      const result = await waitForHealth(39999, 1500);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      // Should take close to timeout duration
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
    });

    it('should succeed after server becomes available', async () => {
      let callCount = 0;
      global.fetch = mock(() => {
        callCount++;
        // Fail first 2 calls, succeed on third
        if (callCount < 3) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('')
        } as unknown as Response);
      });

      const result = await waitForHealth(37777, 5000);

      expect(result).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should check health endpoint for liveness', async () => {
      const fetchMock = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));
      global.fetch = fetchMock;

      await waitForHealth(37777, 1000);

      // waitForHealth uses /api/health (liveness), not /api/readiness
      // This is because hooks have 15-second timeout but full initialization can take 5+ minutes
      // See: https://github.com/thedotmack/claude-mem/issues/811
      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][0]).toBe('http://127.0.0.1:37777/api/health');
    });

    it('should use default timeout when not specified', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));

      // Just verify it doesn't throw and returns quickly
      const result = await waitForHealth(37777);

      expect(result).toBe(true);
    });
  });

  describe('getInstalledPluginVersion', () => {
    it('should return a valid semver string', () => {
      const version = getInstalledPluginVersion();

      // Should be a string matching semver pattern or 'unknown'
      if (version !== 'unknown') {
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
      }
    });

    it('should not throw on ENOENT (graceful degradation)', () => {
      // The function handles ENOENT internally — should not throw
      // If package.json exists, it returns the version; if not, 'unknown'
      expect(() => getInstalledPluginVersion()).not.toThrow();
    });
  });

  describe('checkVersionMatch', () => {
    it('should assume match when worker version is unavailable', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await checkVersionMatch(39999);

      expect(result.matches).toBe(true);
      expect(result.workerVersion).toBeNull();
    });

    it('should detect version mismatch', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: '0.0.0-definitely-wrong' }))
      } as unknown as Response));

      const result = await checkVersionMatch(37777);

      // Unless the plugin version is also '0.0.0-definitely-wrong', this should be a mismatch
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion !== 'unknown' && pluginVersion !== '0.0.0-definitely-wrong') {
        expect(result.matches).toBe(false);
      }
    });

    it('should detect version match', async () => {
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion === 'unknown') return; // Skip if can't read plugin version

      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: pluginVersion }))
      } as unknown as Response));

      const result = await checkVersionMatch(37777);

      expect(result.matches).toBe(true);
      expect(result.pluginVersion).toBe(pluginVersion);
      expect(result.workerVersion).toBe(pluginVersion);
    });
  });

  describe('waitForPortFree', () => {
    it('should return true immediately when port is already free', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'listening') setTimeout(() => cb(), 0);
        }),
        listen: mock(() => {}),
        close: mock((cb: Function) => cb())
      }));
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const start = Date.now();
      const result = await waitForPortFree(39999, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(1000);
      spy.mockRestore();
    });

    it('should timeout when port remains occupied', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
        }),
        listen: mock(() => {})
      }));
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const start = Date.now();
      const result = await waitForPortFree(37777, 1500);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
      spy.mockRestore();
    });

    it('should succeed when port becomes free', async () => {
      let callCount = 0;
      const spy = spyOn(net, 'createServer').mockImplementation(() => ({
        once: mock((event: string, cb: Function) => {
          callCount++;
          // Port occupied for first 2 checks, then free
          if (callCount < 3) {
            if (event === 'error') setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
          } else {
            if (event === 'listening') setTimeout(() => cb(), 0);
          }
        }),
        listen: mock(() => {}),
        close: mock((cb: Function) => cb())
      } as any));

      const result = await waitForPortFree(37777, 5000);

      expect(result).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
      spy.mockRestore();
    });

    it('should use default timeout when not specified', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'listening') setTimeout(() => cb(), 0);
        }),
        listen: mock(() => {}),
        close: mock((cb: Function) => cb())
      }));
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await waitForPortFree(39999);

      expect(result).toBe(true);
      spy.mockRestore();
    });
  });
});
