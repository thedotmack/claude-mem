import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { WorkerService } from '../../src/services/worker-service.js';
import { IdleExitMonitor } from '../../src/services/worker/idle-exit-monitor.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { logger } from '../../src/utils/logger.js';

// WorkerService.startIdleExitMonitor wires the monitor to the worker's real
// signals. These tests run it on a bare prototype (no providers, database,
// signal handlers or HTTP server) with a controlled clock and interval.

afterEach(() => mock.restore());

function fixture(options: { shutdownSettles?: boolean } = {}) {
  const worker = Object.create(WorkerService.prototype) as any;
  const signals = { inFlightRequests: 0, viewerClients: 0 };
  // Unless a test opts in, the shutdown never settles, so the idle path's
  // process.exit can never run after the mocks are restored.
  const shutdown = mock((_reason: string) => options.shutdownSettles
    ? Promise.resolve()
    : new Promise<void>(() => {}));
  Object.assign(worker, {
    idleExitMonitor: null,
    transcriptWatcher: null,
    memoryFileWatcher: null,
    lastAiInteraction: null,
    sessionManager: { hasSessionActivitySince: () => false, getTotalQueueDepth: () => 0 },
    server: { getLastRequestAt: () => null, getInFlightRequestCount: () => signals.inFlightRequests },
    sseBroadcaster: { getClientCount: () => signals.viewerClients },
    shutdown,
  });
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});
  let nowMs = 1_000_000;
  spyOn(Date, 'now').mockImplementation(() => nowMs);
  let tick: () => void = () => { throw new Error('no idle-exit interval armed'); };
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback;
    return { unref() {} };
  }) as any);
  spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  return {
    worker,
    signals,
    shutdown,
    warn,
    interval,
    exit,
    advance: (ms: number) => { nowMs += ms; },
    tick: () => tick(),
  };
}

const settings = (overrides: Record<string, string> = {}) => ({
  CLAUDE_MEM_IDLE_EXIT_SEC: '600',
  CLAUDE_MEM_WORKER_AUTOSTART: 'true',
  ...overrides,
});

const warned = (warn: ReturnType<typeof spyOn>, text: string) =>
  warn.mock.calls.some(call => String(call[1]).includes(text));

describe('WorkerService.startIdleExitMonitor', () => {
  it('never constructs the monitor for the default 0', () => {
    const h = fixture();
    h.worker.startIdleExitMonitor(settings({ CLAUDE_MEM_IDLE_EXIT_SEC: '0' }));
    expect(h.worker.idleExitMonitor).toBeNull();
    expect(h.interval).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('warns and stays off for a value that is not whole seconds or overflows milliseconds', () => {
    for (const value of ['abc', '1.5', '-1', '1e308']) {
      const h = fixture();
      h.worker.startIdleExitMonitor(settings({ CLAUDE_MEM_IDLE_EXIT_SEC: value }));
      expect(h.worker.idleExitMonitor).toBeNull();
      expect(h.interval).not.toHaveBeenCalled();
      expect(warned(h.warn, 'invalid CLAUDE_MEM_IDLE_EXIT_SEC')).toBe(true);
      mock.restore();
    }
  });

  it('stays off with CLAUDE_MEM_WORKER_AUTOSTART=false, since nothing would start the worker again', () => {
    const h = fixture();
    h.worker.startIdleExitMonitor(settings({ CLAUDE_MEM_WORKER_AUTOSTART: 'false' }));
    expect(h.worker.idleExitMonitor).toBeNull();
    expect(h.interval).not.toHaveBeenCalled();
    expect(warned(h.warn, 'CLAUDE_MEM_WORKER_AUTOSTART=false')).toBe(true);
  });

  it('stays off while the transcript watcher runs, since only the worker captures those hosts', () => {
    const h = fixture();
    h.worker.transcriptWatcher = { stop() {} };
    h.worker.startIdleExitMonitor(settings());
    expect(h.worker.idleExitMonitor).toBeNull();
    expect(h.interval).not.toHaveBeenCalled();
    expect(warned(h.warn, 'transcript watches are active')).toBe(true);
  });

  it('raises a window under 60 s to the 60 s minimum', () => {
    const h = fixture();
    h.worker.startIdleExitMonitor(settings({ CLAUDE_MEM_IDLE_EXIT_SEC: '5' }));
    expect(h.worker.idleExitMonitor).toBeInstanceOf(IdleExitMonitor);
    expect(warned(h.warn, '60 s minimum')).toBe(true);
    h.advance(59_000);
    h.tick();
    expect(h.shutdown).not.toHaveBeenCalled();
    h.advance(1_000);
    h.tick();
    expect(h.shutdown).toHaveBeenCalledWith('idle');
  });

  it('stays off while memory folders are watched, so external notes remain captured', () => {
    const h = fixture();
    h.worker.memoryFileWatcher = { stop() {} };
    h.worker.startIdleExitMonitor(settings());
    expect(h.worker.idleExitMonitor).toBeNull();
    expect(h.interval).not.toHaveBeenCalled();
    expect(warned(h.warn, 'memory-file watches are active')).toBe(true);
  });

  it('stays up while a viewer is connected or a request is open, then exits through the idle shutdown', async () => {
    const h = fixture({ shutdownSettles: true });
    h.worker.startIdleExitMonitor(settings());
    expect(h.worker.idleExitMonitor.isRunning()).toBe(true);

    h.signals.viewerClients = 1; // a viewer tab on the event stream
    h.advance(600_000);
    h.tick();
    h.signals.viewerClients = 0;
    h.signals.inFlightRequests = 1; // a corpus prime that outlasts the window
    h.advance(600_000);
    h.tick();
    expect(h.shutdown).not.toHaveBeenCalled();

    h.signals.inFlightRequests = 0;
    h.advance(599_000);
    h.tick();
    expect(h.shutdown).not.toHaveBeenCalled();
    h.advance(1_000);
    h.tick();
    expect(h.shutdown).toHaveBeenCalledTimes(1);
    expect(h.shutdown).toHaveBeenCalledWith('idle');
    await new Promise<void>(resolve => queueMicrotask(resolve));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('SessionManager.hasSessionActivitySince', () => {
  it('counts a running generator as activity, so an in-flight observer reply is never cut off', () => {
    const manager = new SessionManager({} as never);
    const sessions = (manager as any).sessions as Map<number, { lastGeneratorActivity: number; generatorPromise: Promise<void> | null }>;
    const session = { lastGeneratorActivity: 1_000, generatorPromise: null as Promise<void> | null };
    sessions.set(1, session);

    expect(manager.hasSessionActivitySince(5_000)).toBe(false);
    session.generatorPromise = new Promise<void>(() => {}); // waiting on the provider, nothing buffered
    expect(manager.hasSessionActivitySince(5_000)).toBe(true);
    session.generatorPromise = null;
    session.lastGeneratorActivity = 5_000;
    expect(manager.hasSessionActivitySince(5_000)).toBe(true);
  });
});
