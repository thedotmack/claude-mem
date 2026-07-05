import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import net from 'net';
import {
  formatHostForUrl,
  isPortInUse,
  probePortBind,
  waitForHealth,
  waitForPortFree,
  getInstalledPluginVersion,
  checkVersionMatch
} from '../../src/services/infrastructure/index.js';

describe('HealthMonitor', () => {
  const originalFetch = global.fetch;
  const originalWorkerHost = process.env.CLAUDE_MEM_WORKER_HOST;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalWorkerHost === undefined) delete process.env.CLAUDE_MEM_WORKER_HOST;
    else process.env.CLAUDE_MEM_WORKER_HOST = originalWorkerHost;
  });

  describe('formatHostForUrl', () => {
    it('brackets IPv6 literals for HTTP URLs', () => {
      expect(formatHostForUrl('::1')).toBe('[::1]');
      expect(formatHostForUrl('[::1]')).toBe('[::1]');
      expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1');
      expect(formatHostForUrl('localhost')).toBe('localhost');
    });
  });

  describe('isPortInUse', () => {

    it('should return true for occupied port (EADDRINUSE)', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') {
            setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
          }
        }),
        listen: mock(() => {})
      }));
      
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(37777);

      expect(result).toBe(true);
      expect(net.createServer).toHaveBeenCalled();
      expect((createServerMock.mock.results[0]?.value as any).listen).toHaveBeenCalledWith(37777, '127.0.0.1');
      
      spy.mockRestore();
    });

    it('should return false for free port (listening succeeds)', async () => {
      const closeMock = mock((cb: Function) => cb());
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'listening') {
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
      expect((createServerMock.mock.results[0]?.value as any).listen).toHaveBeenCalledWith(39999, '127.0.0.1');
      
      spy.mockRestore();
    });

    it('should return false for other socket errors', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') {
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

  describe('probePortBind', () => {
    it('returns null when the worker port is bindable', async () => {
      const closeMock = mock((cb: Function) => cb());
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'listening') setTimeout(() => cb(), 0);
        }),
        listen: mock(() => {}),
        close: closeMock
      }));
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await probePortBind(37777, '127.0.0.1');

      expect(result).toBeNull();
      expect(closeMock).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('returns EADDRINUSE when a stale socket still owns the port', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
        }),
        listen: mock(() => {})
      }));
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await probePortBind(37777, '127.0.0.1');

      expect(result).toBe('EADDRINUSE');
      spy.mockRestore();
    });

    it('preserves non-conflict bind errors for actionable diagnostics', async () => {
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'error') setTimeout(() => cb({ code: 'EADDRNOTAVAIL' }), 0);
        }),
        listen: mock(() => {})
      }));
      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await probePortBind(37777, '::ffff');

      expect(result).toBe('EADDRNOTAVAIL');
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
      expect(elapsed).toBeLessThan(1000);
    });

    it('should timeout when no server responds', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const start = Date.now();
      const result = await waitForHealth(39999, 1500);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
    });

    it('should succeed after server becomes available', async () => {
      let callCount = 0;
      global.fetch = mock(() => {
        callCount++;
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

      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][0]).toBe('http://127.0.0.1:37777/api/health');
    });

    it('uses CLAUDE_MEM_WORKER_HOST and formats IPv6 literals in health URLs', async () => {
      process.env.CLAUDE_MEM_WORKER_HOST = '::1';
      const fetchMock = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));
      global.fetch = fetchMock;

      await waitForHealth(37777, 1000);

      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][0]).toBe('http://[::1]:37777/api/health');
    });

    it('should use default timeout when not specified', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));

      const result = await waitForHealth(37777);

      expect(result).toBe(true);
    });
  });

  describe('getInstalledPluginVersion', () => {
    it('should return a valid semver string', () => {
      const version = getInstalledPluginVersion();

      if (version !== 'unknown') {
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
      }
    });

    it('should not throw on ENOENT (graceful degradation)', () => {
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

      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion !== 'unknown' && pluginVersion !== '0.0.0-definitely-wrong') {
        expect(result.matches).toBe(false);
      }
    });

    it('should detect version match', async () => {
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion === 'unknown') return; 

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
