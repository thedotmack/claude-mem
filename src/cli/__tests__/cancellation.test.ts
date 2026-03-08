import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';

const mockLogger: Record<string, any> = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  failure: () => {},
  dataIn: () => {},
  formatTool: () => 'MockTool',
};

mock.module('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

mock.module('../adapters/index.js', () => ({
  getPlatformAdapter: () => ({
    normalizeInput: (raw: any) => ({ ...(raw ?? {}) }),
    formatOutput: (result: any) => result,
  }),
}));

mock.module('../handlers/index.js', () => ({
  getEventHandler: () => ({
    execute: async () => ({ continue: true, suppressOutput: true }),
  }),
}));

import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

class ManualFakeTimers {
  private nowMs = 0;
  private nextId = 1;
  private pending = new Map<number, { at: number; callback: () => void }>();
  private originalSetTimeout = global.setTimeout;
  private originalClearTimeout = global.clearTimeout;

  install(): void {
    const timers = this;

    global.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      const id = timers.nextId++;
      timers.pending.set(id, {
        at: timers.nowMs + (delay ?? 0),
        callback: () => callback(...args),
      });
      return id as any;
    }) as typeof global.setTimeout;

    global.clearTimeout = ((id: number) => {
      timers.pending.delete(Number(id));
    }) as typeof global.clearTimeout;
  }

  restore(): void {
    global.setTimeout = this.originalSetTimeout;
    global.clearTimeout = this.originalClearTimeout;
    this.pending.clear();
  }

  tick(ms: number): void {
    const target = this.nowMs + ms;

    while (true) {
      const next = [...this.pending.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .find(([, timer]) => timer.at <= target);

      if (!next) break;

      const [id, timer] = next;
      this.pending.delete(id);
      this.nowMs = timer.at;
      timer.callback();
    }

    this.nowMs = target;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = false;
  readable = true;
}

function makeAbortError(): Error & { name: string } {
  return Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
}

describe('CLI cancellation cleanup', () => {
  const originalFetch = global.fetch;
  const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

  let timers: ManualFakeTimers;
  let errorMock: ReturnType<typeof mock>;
  let warnMock: ReturnType<typeof mock>;
  let debugMock: ReturnType<typeof mock>;

  beforeEach(() => {
    timers = new ManualFakeTimers();
    timers.install();

    errorMock = mock(() => {});
    warnMock = mock(() => {});
    debugMock = mock(() => {});

    mockLogger.error = errorMock;
    mockLogger.warn = warnMock;
    mockLogger.debug = debugMock;
    mockLogger.info = mock(() => {});
    mockLogger.failure = mock(() => {});
    mockLogger.dataIn = mock(() => {});
    mockLogger.formatTool = () => 'MockTool';

    global.fetch = originalFetch;
  });

  afterEach(() => {
    timers.restore();
    global.fetch = originalFetch;

    if (originalStdinDescriptor) {
      Object.defineProperty(process, 'stdin', originalStdinDescriptor);
    }
  });

  it.skip('should close open DB handles or delete temp files on SIGINT during long-running CLI work', () => {
    // TODO: `src/cli` currently has no SIGINT handler (`process.on/once("SIGINT")`) to
    // trigger resource cleanup. This is a real risk for `generateClaudeMd()` in
    // `src/cli/claude-md-commands.ts`, which opens a `bun:sqlite` Database and calls
    // `db.close()` only after the full folder loop completes.
    // Production change needed:
    // 1. register a SIGINT handler for the operation,
    // 2. wrap the Database lifecycle in `try/finally`, and
    // 3. clean any temp output before returning a non-zero exit code.
  });

  it('returns a blocking non-zero exit on timeout and cleans stdin listeners without hanging', async () => {
    const fakeStdin = new FakeStdin();
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeStdin,
    });

    const { readJsonFromStdin } = await import('../stdin-reader.js?cancellation-cleanup');
    const readPromise = readJsonFromStdin();

    expect(fakeStdin.listenerCount('data')).toBe(1);
    expect(fakeStdin.listenerCount('end')).toBe(1);
    expect(fakeStdin.listenerCount('error')).toBe(1);

    fakeStdin.emit('data', '{"broken":');
    await Promise.resolve();

    expect(fakeStdin.listenerCount('data')).toBe(1);
    expect(fakeStdin.listenerCount('end')).toBe(1);
    expect(fakeStdin.listenerCount('error')).toBe(1);
    expect(timers.pendingCount()).toBe(2);

    timers.tick(50);
    await Promise.resolve();

    timers.tick(30000);
    await expect(readPromise).rejects.toThrow('Incomplete JSON after 30000ms');

    expect(fakeStdin.listenerCount('data')).toBe(0);
    expect(fakeStdin.listenerCount('end')).toBe(0);
    expect(fakeStdin.listenerCount('error')).toBe(0);
    expect(timers.pendingCount()).toBe(0);

    mock.module('../stdin-reader.js', () => ({
      readJsonFromStdin: async () => {
        throw new Error('Incomplete JSON after 30000ms: {\"broken\":...');
      },
    }));

    const { hookCommand } = await import('../hook-command.js?cancellation-exit');
    const exitCode = await hookCommand('claude-code', 'session-init', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.BLOCKING_ERROR);
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0][1])).toContain('Incomplete JSON after 30000ms');
    expect(typeof process.stderr.write).toBe('function');
  });

  it('rejects on timeout without leaving pending timer handles', async () => {
    const fetchMock = mock(() => new Promise<Response>(() => {}));
    global.fetch = fetchMock as typeof global.fetch;

    const { fetchWithTimeout } = await import('../../shared/worker-utils.js?cancellation-timeout');
    const request = fetchWithTimeout('http://127.0.0.1:37777/api/health', {}, 5000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(1);

    timers.tick(5000);

    await expect(request).rejects.toThrow('Request timed out after 5000ms');
    expect(timers.pendingCount()).toBe(0);
  });

  it('stops cleanly when an AbortController aborts mid-operation', async () => {
    const abortError = makeAbortError();
    const fetchMock = mock((_: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;

        if (signal?.aborted) {
          reject(abortError);
          return;
        }

        signal?.addEventListener('abort', () => reject(abortError), { once: true });
      });
    });
    global.fetch = fetchMock as typeof global.fetch;

    const controller = new AbortController();
    const { fetchWithTimeout } = await import('../../shared/worker-utils.js?cancellation-abort');
    const request = fetchWithTimeout(
      'http://127.0.0.1:37777/api/slow',
      { signal: controller.signal },
      5000
    );

    setTimeout(() => controller.abort(), 1000);
    expect(timers.pendingCount()).toBe(2);

    timers.tick(1000);

    await expect(request).rejects.toMatchObject({
      message: 'Operation aborted',
      name: 'AbortError',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(0);
  });
});

