import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import net from 'net';
import {
  isPortInUse,
  waitForHealth,
  waitForPortFree,
  getRunningWorkerVersion,
  checkVersionMatch
} from '../../src/services/infrastructure/index.js';

describe('HealthMonitor', () => {
  const originalFetch = global.fetch;
  const originalWorkerHost = process.env.CLAUDE_MEM_WORKER_HOST;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalWorkerHost === undefined) {
      delete process.env.CLAUDE_MEM_WORKER_HOST;
    } else {
      process.env.CLAUDE_MEM_WORKER_HOST = originalWorkerHost;
    }
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
      
      spy.mockRestore();
    });

    it('should honor configured worker host when probing port occupancy', async () => {
      process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.2';
      const closeMock = mock((cb: Function) => cb());
      const listenMock = mock(() => {});
      const createServerMock = mock(() => ({
        once: mock((event: string, cb: Function) => {
          if (event === 'listening') {
            setTimeout(() => cb(), 0);
          }
        }),
        listen: listenMock,
        close: closeMock
      }));

      const spy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

      const result = await isPortInUse(37777);

      expect(result).toBe(false);
      expect(listenMock).toHaveBeenCalledWith(37777, '127.0.0.2');

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

    it('should fall through to socket probe on Windows when health check fails and port is actually in use (zombie port)', async () => {
      // Simulate a zombie process: the port is occupied but does not serve HTTP.
      // fetch for /api/health throws, then net.createServer hits EADDRINUSE.
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        global.fetch = mock(() => Promise.reject(new Error('fetch failed')));

        const createServerMock = mock(() => ({
          once: mock((event: string, cb: Function) => {
            if (event === 'error') {
              setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
            }
          }),
          listen: mock(() => {}),
        }));

        const netSpy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

        const result = await isPortInUse(37777);

        expect(result).toBe(true);
        expect(global.fetch).toHaveBeenCalled();
        expect(net.createServer).toHaveBeenCalled();

        netSpy.mockRestore();
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      }
    });

    it('should probe Windows health through an abortable signal so a ghost listener cannot hang it (#3603)', async () => {
      const origPlatform = process.platform;
      let restoreNet: (() => void) | undefined;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        // A ghost listener completes the TCP handshake and never answers, so a
        // probe without its own abort budget never settles — and
        // ensureWorkerStarted(), which runs this check BEFORE it can reach the
        // ghost reclaim, hangs with it. The abort signal is the fix: capture
        // it off the call, and model the abort as the rejection it produces.
        const inits: Array<RequestInit | undefined> = [];
        const fetchMock = mock((_url: string, init?: RequestInit) => {
          inits.push(init);
          const abortError = new Error('The operation was aborted due to timeout');
          abortError.name = 'TimeoutError';
          return Promise.reject(abortError);
        });
        global.fetch = fetchMock as any;

        const createServerMock = mock(() => ({
          once: mock((event: string, cb: Function) => {
            if (event === 'error') setTimeout(() => cb({ code: 'EADDRINUSE' }), 0);
          }),
          listen: mock(() => {}),
        }));

        const netSpy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);
        restoreNet = () => netSpy.mockRestore();

        const result = await isPortInUse(37777);

        expect(inits.length).toBeGreaterThan(0);
        expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
        // An aborted probe is inconclusive, never "free": the flow falls
        // through to the socket probe, which reports the bound port as in use
        // so the launcher can go on to reclaim the ghost.
        expect(result).toBe(true);
        expect(net.createServer).toHaveBeenCalled();
      } finally {
        // Failure-safe: a failed assertion above must not leave the net mock
        // installed for later tests in this file.
        restoreNet?.();
        Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      }
    });

    it('should fall through to socket probe on Windows when health check fails and port is actually free', async () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

        const closeMock = mock((cb: Function) => cb());
        const createServerMock = mock(() => ({
          once: mock((event: string, cb: Function) => {
            if (event === 'listening') {
              setTimeout(() => cb(), 0);
            }
          }),
          listen: mock(() => {}),
          close: closeMock,
        }));

        const netSpy = spyOn(net, 'createServer').mockImplementation(createServerMock as any);

        const result = await isPortInUse(39999);

        expect(result).toBe(false);
        expect(global.fetch).toHaveBeenCalled();
        expect(net.createServer).toHaveBeenCalled();
        expect(closeMock).toHaveBeenCalled();

        netSpy.mockRestore();
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      }
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

    // #3575 leftover after plan-15 already bounded each probe at 5s: a hung
    // fetch must still honor the *caller* deadline, not sit out the full
    // HEALTH_PROBE_TIMEOUT_MS. Without the remaining-ms cap, waitForHealth(100)
    // would block ~5s inside AbortSignal.timeout.
    it('should abort a fetch that never responds within the overall timeout', async () => {
      global.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('expected an abort signal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));

      const start = Date.now();
      const result = await waitForHealth(39999, 100);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(500);
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

    it('should honor configured worker host when polling health', async () => {
      process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.2';
      const fetchMock = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));
      global.fetch = fetchMock;

      await waitForHealth(37777, 1000);

      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.2:37777/api/health');
    });

    it('should normalize a localhost worker host to 127.0.0.1 when polling health', async () => {
      // 'localhost' resolves IPv6-first on modern Windows while the worker
      // binds a single family, so SettingsDefaultsManager pins it to the
      // IPv4 loopback (#2992) — the poll URL must reflect that.
      process.env.CLAUDE_MEM_WORKER_HOST = 'localhost';
      const fetchMock = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('')
      } as unknown as Response));
      global.fetch = fetchMock;

      await waitForHealth(37777, 1000);

      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:37777/api/health');
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

  describe('checkVersionMatch', () => {
    it('reads the running worker version from /api/health, not /api/version', async () => {
      const fetchMock = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: '13.10.1' }))
      } as unknown as Response));
      global.fetch = fetchMock;

      const version = await getRunningWorkerVersion(37777);

      expect(version).toBe('13.10.1');
      expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:37777/api/health');
    });

    it('assumes match when the worker version is unavailable', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await checkVersionMatch(39999, '13.12.0');

      expect(result.matches).toBe(true);
      expect(result.workerVersion).toBeNull();
    });

    it('assumes match when the caller-supplied expected version is unknown', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: '13.11.0' }))
      } as unknown as Response));

      const result = await checkVersionMatch(37777, null);

      expect(result.matches).toBe(true);
      expect(result.pluginVersion).toBe('unknown');
      expect(result.workerVersion).toBe('13.11.0');
    });

    it('detects a mismatch against the caller-supplied expected version', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: '13.11.0' }))
      } as unknown as Response));

      const result = await checkVersionMatch(37777, '13.12.0');

      expect(result.matches).toBe(false);
      expect(result.pluginVersion).toBe('13.12.0');
      expect(result.workerVersion).toBe('13.11.0');
    });

    it('detects a match against the caller-supplied expected version', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: '13.12.0' }))
      } as unknown as Response));

      const result = await checkVersionMatch(37777, '13.12.0');

      expect(result.matches).toBe(true);
      expect(result.pluginVersion).toBe('13.12.0');
      expect(result.workerVersion).toBe('13.12.0');
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
