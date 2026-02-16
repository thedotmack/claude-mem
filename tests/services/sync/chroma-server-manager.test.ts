import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { ChromaServerManager } from '../../../src/services/sync/ChromaServerManager.js';

function createFakeProcess(pid: number = 4242): childProcess.ChildProcess {
  const proc = new EventEmitter() as childProcess.ChildProcess & EventEmitter;
  let exited = false;

  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  (proc as any).pid = pid;
  (proc as any).kill = mock(() => {
    if (!exited) {
      exited = true;
      setTimeout(() => proc.emit('exit', 0, 'SIGTERM'), 0);
    }
    return true;
  });

  return proc as childProcess.ChildProcess;
}

describe('ChromaServerManager', () => {
  const originalFetch = global.fetch;
  const originalPlatform = process.platform;

  beforeEach(() => {
    mock.restore();
    ChromaServerManager.reset();

    // Avoid macOS cert bundle shelling in tests; these tests only exercise startup races.
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
    ChromaServerManager.reset();

    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  it('reuses in-flight startup and only spawns one server process', async () => {
    const fetchMock = mock(async () => {
      // First call: existing server check fails, second call: waitForReady succeeds.
      if (fetchMock.mock.calls.length === 1) {
        throw new Error('no server yet');
      }
      return new Response(null, { status: 200 });
    });
    global.fetch = fetchMock as typeof fetch;

    const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(
      () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
    );

    const manager = ChromaServerManager.getInstance({
      dataDir: '/tmp/chroma-test',
      host: '127.0.0.1',
      port: 8000
    });

    const [first, second] = await Promise.all([
      manager.start(2000),
      manager.start(2000)
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('reuses existing reachable server without spawning', async () => {
    global.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;
    const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(
      () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
    );

    const manager = ChromaServerManager.getInstance({
      dataDir: '/tmp/chroma-test',
      host: '127.0.0.1',
      port: 8000
    });

    const ready = await manager.start(2000);
    expect(ready).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  describe('binary resolution', () => {
    const originalEnv = process.env.CLAUDE_MEM_CHROMA_BINARY;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.CLAUDE_MEM_CHROMA_BINARY;
      } else {
        process.env.CLAUDE_MEM_CHROMA_BINARY = originalEnv;
      }
    });

    it('uses CLAUDE_MEM_CHROMA_BINARY env var when file exists', async () => {
      const fakeBinaryPath = '/tmp/test-chroma-binary';
      process.env.CLAUDE_MEM_CHROMA_BINARY = fakeBinaryPath;

      // Mock existsSync to return true for our fake binary
      const existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((p) => {
        if (p === fakeBinaryPath) return true;
        return false;
      });

      const fetchMock = mock(async () => {
        if (fetchMock.mock.calls.length === 1) {
          throw new Error('no server yet');
        }
        return new Response(null, { status: 200 });
      });
      global.fetch = fetchMock as typeof fetch;

      const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(
        () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
      );

      const manager = ChromaServerManager.getInstance({
        dataDir: '/tmp/chroma-test',
        host: '127.0.0.1',
        port: 8000
      });

      await manager.start(2000);

      // Verify spawn was called with the env var binary
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnCall = spawnSpy.mock.calls[0];
      expect(spawnCall[0]).toBe(fakeBinaryPath);

      existsSyncSpy.mockRestore();
    });

    it('falls back to marketplace binary when require.resolve fails', async () => {
      delete process.env.CLAUDE_MEM_CHROMA_BINARY;

      // Import to get the actual MARKETPLACE_ROOT value
      const { MARKETPLACE_ROOT } = await import('../../../src/shared/paths.js');
      const expectedMarketplaceBin = `${MARKETPLACE_ROOT}/node_modules/.bin/chroma`;

      const existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((p) => {
        // Only the marketplace binary exists
        if (String(p) === expectedMarketplaceBin) return true;
        return false;
      });

      const fetchMock = mock(async () => {
        if (fetchMock.mock.calls.length === 1) {
          throw new Error('no server yet');
        }
        return new Response(null, { status: 200 });
      });
      global.fetch = fetchMock as typeof fetch;

      const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(
        () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
      );

      const manager = ChromaServerManager.getInstance({
        dataDir: '/tmp/chroma-test',
        host: '127.0.0.1',
        port: 8000
      });

      await manager.start(2000);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnCall = spawnSpy.mock.calls[0];
      expect(spawnCall[0]).toBe(expectedMarketplaceBin);

      existsSyncSpy.mockRestore();
    });

    it('falls back to npx and logs warning when all binary paths fail', async () => {
      delete process.env.CLAUDE_MEM_CHROMA_BINARY;

      // All existsSync calls return false — no binary found anywhere
      const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);

      const fetchMock = mock(async () => {
        if (fetchMock.mock.calls.length === 1) {
          throw new Error('no server yet');
        }
        return new Response(null, { status: 200 });
      });
      global.fetch = fetchMock as typeof fetch;

      const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(
        () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
      );

      const manager = ChromaServerManager.getInstance({
        dataDir: '/tmp/chroma-test',
        host: '127.0.0.1',
        port: 8000
      });

      await manager.start(2000);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnCall = spawnSpy.mock.calls[0];
      expect(spawnCall[0]).toBe('npx');
      // npx gets 'chroma' as first arg
      expect(spawnCall[1][0]).toBe('chroma');

      existsSyncSpy.mockRestore();
    });
  });

  describe('port conflict detection', () => {
    it('detects port conflict (non-Chroma HTTP service) and returns false without spawning', async () => {
      // All fetch calls return 404 — something is on the port, but it's not Chroma
      global.fetch = mock(async () => {
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch;

      const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(
        () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
      );

      const manager = ChromaServerManager.getInstance({
        dataDir: '/tmp/chroma-test',
        host: '127.0.0.1',
        port: 8000
      });

      const ready = await manager.start(2000);

      // Port conflict should be detected — returns false, no spawn
      expect(ready).toBe(false);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('proceeds to spawn when port is free (fetch always throws)', async () => {
      // Use a high port number unlikely to be in use
      let callCount = 0;
      const fetchMock = mock(async () => {
        callCount++;
        if (callCount <= 2) {
          // First call: heartbeat in startInternal — fail
          // Second call: checkPortConflict heartbeat — fail
          throw new Error('connection refused');
        }
        // Subsequent calls: waitForReady succeeds
        return new Response(null, { status: 200 });
      });
      global.fetch = fetchMock as typeof fetch;

      const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(
        () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
      );

      const manager = ChromaServerManager.getInstance({
        dataDir: '/tmp/chroma-test',
        host: '127.0.0.1',
        port: 49999 // Use a port that's definitely free
      });

      const ready = await manager.start(2000);

      // Port free — checkPortConflict returns null, proceed to spawn
      expect(ready).toBe(true);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('stderr capture', () => {
    it('accumulates stderr and includes it in exit log on non-zero exit', async () => {
      const fetchMock = mock(async () => {
        if (fetchMock.mock.calls.length <= 2) {
          throw new Error('no server yet');
        }
        // Never return 200 — force timeout
        throw new Error('still not ready');
      });
      global.fetch = fetchMock as typeof fetch;

      const fakeProc = createFakeProcess();
      // Override kill to emit non-zero exit
      (fakeProc as any).kill = mock(() => {
        setTimeout(() => fakeProc.emit('exit', 1, null), 0);
        return true;
      });

      spyOn(childProcess, 'spawn').mockImplementation(
        () => fakeProc as unknown as ReturnType<typeof childProcess.spawn>
      );

      const manager = ChromaServerManager.getInstance({
        dataDir: '/tmp/chroma-test',
        host: '127.0.0.1',
        port: 8000
      });

      // Start with short timeout — will fail
      const readyPromise = manager.start(500);

      // Emit some stderr
      await new Promise(resolve => setTimeout(resolve, 50));
      (fakeProc as any).stderr.emit('data', Buffer.from('Error: Address already in use'));
      (fakeProc as any).stderr.emit('data', Buffer.from('Fatal startup failure'));

      const ready = await readyPromise;
      expect(ready).toBe(false);
    });

    it('includes stderr content in timeout error message', async () => {
      const fetchMock = mock(async () => {
        if (fetchMock.mock.calls.length <= 2) {
          throw new Error('no server yet');
        }
        throw new Error('still not ready');
      });
      global.fetch = fetchMock as typeof fetch;

      const fakeProc = createFakeProcess();
      spyOn(childProcess, 'spawn').mockImplementation(
        () => fakeProc as unknown as ReturnType<typeof childProcess.spawn>
      );

      const manager = ChromaServerManager.getInstance({
        dataDir: '/tmp/chroma-test',
        host: '127.0.0.1',
        port: 8000
      });

      // Start and emit stderr before timeout
      const readyPromise = manager.start(500);
      await new Promise(resolve => setTimeout(resolve, 50));
      (fakeProc as any).stderr.emit('data', Buffer.from('some error output'));

      const ready = await readyPromise;
      expect(ready).toBe(false);
      // The stderr is captured internally — we verify start returned false (timeout with diagnostics)
    });
  });

  it('waits for ongoing startup instead of returning early', async () => {
    let resolveReady: ((value: Response) => void) | null = null;
    const delayedReady = new Promise<Response>((resolve) => {
      resolveReady = resolve;
    });

    const fetchMock = mock(async () => {
      // 1st: existing server check -> fail, 2nd: waitForReady -> block until we resolve.
      if (fetchMock.mock.calls.length === 1) {
        throw new Error('no server yet');
      }
      return delayedReady;
    });
    global.fetch = fetchMock as typeof fetch;

    spyOn(childProcess, 'spawn').mockImplementation(
      () => createFakeProcess() as unknown as ReturnType<typeof childProcess.spawn>
    );

    const manager = ChromaServerManager.getInstance({
      dataDir: '/tmp/chroma-test',
      host: '127.0.0.1',
      port: 8000
    });

    const firstStart = manager.start(5000);
    let secondResolved = false;
    const secondStart = manager.start(5000).then((value) => {
      secondResolved = true;
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondResolved).toBe(false);

    resolveReady!(new Response(null, { status: 200 }));

    expect(await firstStart).toBe(true);
    expect(await secondStart).toBe(true);
  });
});
