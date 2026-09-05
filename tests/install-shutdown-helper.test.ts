import { afterEach, describe, expect, it } from 'bun:test';
import { shutdownWorkerAndWait } from '../src/services/install/shutdown-helper';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('installer worker shutdown', () => {
  it('treats a refused shutdown connection as no running worker', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    }) as typeof fetch;

    await expect(shutdownWorkerAndWait(37777, 0)).resolves.toEqual({
      workerWasRunning: false,
      stopped: true,
    });
  });

  it('does not mistake a generic fetch failure for a stopped worker', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await expect(shutdownWorkerAndWait(37777, 0)).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
    });
  });

  it('accepts a reset shutdown socket only after health is explicitly refused', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
      }
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    }) as typeof fetch;

    await expect(shutdownWorkerAndWait(37777, 0)).resolves.toEqual({
      workerWasRunning: false,
      stopped: true,
    });
  });

  it('fails closed when a running worker rejects shutdown', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

    await expect(shutdownWorkerAndWait(37777, 0)).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
    });
  });

  it('fails closed until health polling confirms the worker exited', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

    await expect(shutdownWorkerAndWait(37777, 0)).resolves.toEqual({
      workerWasRunning: true,
      stopped: false,
    });
  });
});
