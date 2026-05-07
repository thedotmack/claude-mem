import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let portFreeResults: boolean[] = [];

const waitForPortFreeMock = mock(async () => {
  return portFreeResults.shift() ?? false;
});

const { shutdownWorkerAndWait } = await import('../../src/services/install/shutdown-helper.js');

describe('shutdownWorkerAndWait', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    portFreeResults = [];
    waitForPortFreeMock.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('confirms shutdown only after health stops and the port becomes free', async () => {
    const fetchMock = mock((url: string) => {
      if (url.endsWith('/api/admin/shutdown')) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    global.fetch = fetchMock as typeof fetch;
    portFreeResults = [true];

    const result = await shutdownWorkerAndWait(37777, 1, {
      pollIntervalMs: 1,
      portSettleMs: 0,
      waitForPortFree: waitForPortFreeMock,
    });

    expect(result).toEqual({
      workerWasRunning: true,
      healthStoppedResponding: true,
      portFreed: true,
      shutdownConfirmed: true,
    });
    expect(waitForPortFreeMock.mock.calls[0]).toEqual([37777, 1]);
  });

  it('does not confirm shutdown when health stops but the port remains bound', async () => {
    const fetchMock = mock((url: string) => {
      if (url.endsWith('/api/admin/shutdown')) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    global.fetch = fetchMock as typeof fetch;
    portFreeResults = [false];

    const result = await shutdownWorkerAndWait(37777, 1, {
      pollIntervalMs: 1,
      portSettleMs: 0,
      waitForPortFree: waitForPortFreeMock,
    });

    expect(result.shutdownConfirmed).toBe(false);
    expect(result.healthStoppedResponding).toBe(true);
    expect(result.portFreed).toBe(false);
  });

  it('does not confirm a failed shutdown POST for an observed worker that is still healthy', async () => {
    const fetchMock = mock((url: string) => {
      if (url.endsWith('/api/admin/shutdown')) {
        return Promise.reject(new Error('ECONNRESET'));
      }
      return Promise.resolve({ ok: true } as Response);
    });
    global.fetch = fetchMock as typeof fetch;

    const result = await shutdownWorkerAndWait(37777, 1, {
      pollIntervalMs: 1,
      portSettleMs: 0,
      workerWasObserved: true,
      waitForPortFree: waitForPortFreeMock,
    });

    expect(result).toEqual({
      workerWasRunning: true,
      healthStoppedResponding: false,
      portFreed: false,
      shutdownConfirmed: false,
    });
    expect(waitForPortFreeMock).not.toHaveBeenCalled();
  });

  it('does not treat timed-out health checks as stopped health', async () => {
    const timeoutError = new Error('The operation timed out');
    timeoutError.name = 'TimeoutError';
    const fetchMock = mock((url: string) => {
      if (url.endsWith('/api/admin/shutdown')) {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.reject(timeoutError);
    });
    global.fetch = fetchMock as typeof fetch;

    const result = await shutdownWorkerAndWait(37777, 1, {
      pollIntervalMs: 1,
      portSettleMs: 0,
      waitForPortFree: waitForPortFreeMock,
    });

    expect(result.shutdownConfirmed).toBe(false);
    expect(result.healthStoppedResponding).toBe(false);
    expect(waitForPortFreeMock).not.toHaveBeenCalled();
  });

  it('can confirm a failed shutdown POST only when an observed worker is gone afterward', async () => {
    const fetchMock = mock((url: string) => {
      if (url.endsWith('/api/admin/shutdown')) {
        return Promise.reject(new Error('ECONNRESET'));
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    global.fetch = fetchMock as typeof fetch;
    portFreeResults = [true];

    const result = await shutdownWorkerAndWait(37777, 1, {
      pollIntervalMs: 1,
      portSettleMs: 0,
      workerWasObserved: true,
      waitForPortFree: waitForPortFreeMock,
    });

    expect(result).toEqual({
      workerWasRunning: true,
      healthStoppedResponding: true,
      portFreed: true,
      shutdownConfirmed: true,
    });
  });
});
