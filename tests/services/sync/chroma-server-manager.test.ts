import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
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
