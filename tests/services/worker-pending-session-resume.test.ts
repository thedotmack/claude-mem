import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { WorkerService } from '../../src/services/worker-service.js';
import * as gracefulShutdown from '../../src/services/infrastructure/GracefulShutdown.js';
import * as telemetry from '../../src/services/telemetry/telemetry.js';

afterEach(() => mock.restore());

function fixture() {
  // Exercise the lifecycle methods without constructing providers, opening a
  // database, installing signal handlers, or starting an HTTP server.
  const worker = Object.create(WorkerService.prototype) as any;
  Object.assign(worker, {
    pendingSessionResumeTimer: null,
    deferredSessionEndReplayTimer: null,
    isShuttingDown: false,
    initializationCompleteFlag: false,
    startTime: Date.now(),
    server: { getHttpServer: () => undefined },
  });
  let tick!: () => void;
  const timer = { unref: mock(() => {}) };
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback;
    return timer;
  }) as any);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const routes = { resumePendingSessions: mock(() => 2) };
  return { worker, timer, interval, clear, routes, tick: () => tick() };
}

describe('WorkerService pending session resume timer', () => {
  it('runs one unref timer every minute and only sweeps while ready', () => {
    const { worker, timer, interval, routes, tick } = fixture();
    worker.startPendingSessionResume(routes);
    worker.startPendingSessionResume(routes);
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    tick();
    expect(routes.resumePendingSessions).not.toHaveBeenCalled();
    worker.initializationCompleteFlag = true;
    tick();
    expect(routes.resumePendingSessions).toHaveBeenCalledWith('periodic-resume');
    worker.isShuttingDown = true;
    tick();
    expect(routes.resumePendingSessions).toHaveBeenCalledTimes(1);
    worker.stopPendingSessionResume();
  });

  it('shutdown clears the interval before draining sessions and prevents rearming', async () => {
    const { worker, timer, clear, interval, routes, tick } = fixture();
    worker.initializationCompleteFlag = true;
    worker.startPendingSessionResume(routes);
    spyOn(telemetry, 'shutdownTelemetry').mockResolvedValue(undefined);
    const graceful = spyOn(gracefulShutdown, 'performGracefulShutdown').mockImplementation(async () => {
      expect(clear).toHaveBeenCalledWith(timer);
      expect(worker.pendingSessionResumeTimer).toBeNull();
    });
    await worker.shutdown('stop');
    expect(graceful).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    tick(); // A callback already queued when shutdown began must be harmless.
    expect(routes.resumePendingSessions).not.toHaveBeenCalled();
    worker.stopPendingSessionResume();
    worker.startPendingSessionResume(routes);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledTimes(1);
  });
});
