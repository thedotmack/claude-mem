
import { describe, it, expect } from 'bun:test';
import {
  ensureWorkerStarted,
  terminateStaleWorker,
  reuseOrReplaceStaleWorker,
  type StaleWorkerDeps,
  type VersionGateDeps,
} from '../../src/services/worker-spawner.js';

describe('ensureWorkerStarted validation guards', () => {

  it('returns "dead" when workerScriptPath is empty string', async () => {
    const result = await ensureWorkerStarted(39001, '');
    expect(result).toBe('dead');
  });

  it('returns "dead" when workerScriptPath does not exist on disk', async () => {
    const bogusPath = '/tmp/__claude-mem-test-nonexistent-worker-script-' + Date.now() + '.cjs';
    const result = await ensureWorkerStarted(39002, bogusPath);
    expect(result).toBe('dead');
  });
});

function makeDeps(overrides: Partial<StaleWorkerDeps> = {}): { deps: StaleWorkerDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: StaleWorkerDeps = {
    httpShutdown: async () => { calls.push('httpShutdown'); return true; },
    waitForPortFree: async () => { calls.push('waitForPortFree'); return true; },
    readPidFile: () => { calls.push('readPidFile'); return { pid: 4242, port: 39010, startedAt: 'x' }; },
    killProcess: () => { calls.push('killProcess'); },
    isProcessAlive: () => { calls.push('isProcessAlive'); return true; },
    ...overrides,
  };
  return { deps, calls };
}

describe('terminateStaleWorker', () => {
  it('returns true after graceful shutdown frees the port (no kill)', async () => {
    const { deps, calls } = makeDeps({ waitForPortFree: async () => true });
    const freed = await terminateStaleWorker(39010, deps);
    expect(freed).toBe(true);
    expect(calls).toContain('httpShutdown');
    expect(calls).not.toContain('killProcess');
  });

  it('SIGKILLs the PID-file pid when graceful shutdown does not free the port', async () => {
    let portFreeCalls = 0;
    const { deps, calls } = makeDeps({
      waitForPortFree: async () => { portFreeCalls += 1; return portFreeCalls > 1; },
    });
    const freed = await terminateStaleWorker(39010, deps);
    expect(freed).toBe(true);
    expect(calls).toContain('killProcess');
  });

  it('returns false (fail-soft) when port stays occupied and no pid is available', async () => {
    const { deps } = makeDeps({
      waitForPortFree: async () => false,
      readPidFile: () => null,
    });
    const freed = await terminateStaleWorker(39010, deps);
    expect(freed).toBe(false);
  });

  it('treats ESRCH (process already exited) as success when the port is now free', async () => {
    // The stale worker may exit on its own (e.g. from the earlier httpShutdown)
    // between the isProcessAlive check and the SIGKILL, so process.kill throws
    // ESRCH. That is not a failure — the worker is gone; success is decided by
    // whether the port is free, so we must still run waitForPortFree.
    let portFreeCalls = 0;
    const { deps } = makeDeps({
      waitForPortFree: async () => { portFreeCalls += 1; return portFreeCalls > 1; },
      killProcess: () => { const e = new Error('ESRCH') as NodeJS.ErrnoException; e.code = 'ESRCH'; throw e; },
    });
    const freed = await terminateStaleWorker(39010, deps);
    expect(freed).toBe(true);
  });
});

describe('reuseOrReplaceStaleWorker', () => {
  it('returns "reuse" when versions match (never terminates)', async () => {
    let terminated = false;
    const deps: VersionGateDeps = {
      checkVersionMatch: async () => ({ matches: true, pluginVersion: '13.4.0', workerVersion: '13.4.0' }),
      terminateStaleWorker: async () => { terminated = true; return true; },
    };
    const outcome = await reuseOrReplaceStaleWorker(39011, deps);
    expect(outcome).toBe('reuse');
    expect(terminated).toBe(false);
  });

  it('returns "replace" when versions differ and termination frees the port', async () => {
    const deps: VersionGateDeps = {
      checkVersionMatch: async () => ({ matches: false, pluginVersion: '13.5.0', workerVersion: '13.4.0' }),
      terminateStaleWorker: async () => true,
    };
    const outcome = await reuseOrReplaceStaleWorker(39011, deps);
    expect(outcome).toBe('replace');
  });

  it('returns "keep" when versions differ but the port cannot be freed (fail-soft)', async () => {
    const deps: VersionGateDeps = {
      checkVersionMatch: async () => ({ matches: false, pluginVersion: '13.5.0', workerVersion: '13.4.0' }),
      terminateStaleWorker: async () => false,
    };
    const outcome = await reuseOrReplaceStaleWorker(39011, deps);
    expect(outcome).toBe('keep');
  });
});
