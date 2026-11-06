import { describe, it, expect } from 'bun:test';
import { CodexAppServerPool, boundedInteger } from '../../src/services/worker/CodexAppServerPool.js';
const options = { codexPath: 'codex', model: '', reasoningEffort: null, timeoutMs: 1000, prompt: '' };
function harness() {
  const started: string[] = [];
  const finish: Array<() => void> = [];
  let busy = 0, peak = 0, closed = 0, recycled = 0;
  const pool = new CodexAppServerPool(2, () => ({
    runTurn: async (o) => {
      started.push(o.prompt); busy++; peak = Math.max(peak, busy);
      try { return await new Promise<{content: string}>((resolve, reject) => {
        finish.push(() => resolve({ content: o.prompt }));
        o.signal?.addEventListener('abort', () => reject(o.signal!.reason), { once: true });
      }); } finally { busy--; }
    }, close: async () => { closed++; }, recycle: async () => { recycled++; },
  }));
  return { pool, started, finish, stats: () => ({ busy, peak, closed, recycled }) };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('Codex pool', () => {
  it('bounds concurrency and admits waiting requests FIFO', async () => {
    const h = harness();
    const jobs = ['a','b','c','d'].map(prompt => h.pool.runTurn({ ...options, prompt }));
    await tick(); expect(h.started).toEqual(['a','b']);
    h.finish[1](); await tick(); expect(h.started).toEqual(['a','b','c']);
    h.finish[0](); await tick(); expect(h.started).toEqual(['a','b','c','d']);
    h.finish[2](); h.finish[3](); await Promise.all(jobs);
    expect(h.stats().peak).toBe(2); await h.pool.close(); expect(h.stats().closed).toBe(2);
  });
  it('cancels queued and inflight requests and closes all clients idempotently', async () => {
    const h = harness(); const abort = new AbortController(); const queued = new AbortController();
    const a = h.pool.runTurn({ ...options, signal: abort.signal }).catch(e => e);
    const b = h.pool.runTurn(options).catch(e => e);
    const c = h.pool.runTurn({ ...options, signal: queued.signal }).catch(e => e);
    const d = h.pool.runTurn(options).catch(e => e);
    await tick(); queued.abort(); expect(await c).toBeInstanceOf(Error);
    abort.abort(); expect(await a).toBeInstanceOf(Error);
    await tick(); const close = h.pool.close(); expect(h.pool.close()).toBe(close);
    await close; await Promise.all([b,d]); expect(h.stats().closed).toBe(2);
    expect(h.started).toHaveLength(3);
    await expect(h.pool.runTurn(options)).rejects.toThrow('closed');
  });
  it('rejects unsafe configuration values', () => {
    for (const value of [0, -1, 9, 1.5, '', 'oops']) expect(boundedInteger(value, 2, 8)).toBe(2);
    expect(boundedInteger('8', 2, 8)).toBe(8);
  });
  it('recycleIdle recycles idle clients and leaves active ones alone', async () => {
    const h = harness();
    // Start one job so one client is active, one is idle
    const job = h.pool.runTurn({ ...options, prompt: 'active' });
    await tick();
    expect(h.started).toEqual(['active']);
    // Recycle idle clients — only the idle one (not the active one)
    await h.pool.recycleIdle();
    expect(h.stats().recycled).toBe(1);
    // Finish the active job and wait for the client to return to idle
    h.finish[0]();
    await job;
    await tick();
    // Now both are idle; recycle again
    await h.pool.recycleIdle();
    expect(h.stats().recycled).toBe(3);
    await h.pool.close();
  });
  it('recycleIdle is a no-op when all clients are active', async () => {
    const h = harness();
    const a = h.pool.runTurn({ ...options, prompt: 'a' });
    const b = h.pool.runTurn({ ...options, prompt: 'b' });
    await tick();
    await h.pool.recycleIdle();
    expect(h.stats().recycled).toBe(0);
    h.finish[0](); h.finish[1]();
    await Promise.all([a, b]);
    await h.pool.close();
  });
  it('auth probe: a recycled client respawns a child that reads fresh credentials and stays reusable', async () => {
    // auth.json lives on disk; `codex login` rewrites it while the running
    // app-server child keeps only its in-memory copy in `childHolds`.
    let tokenOnDisk = 'auth-v1';
    const served: Array<{ prompt: string; tokenHeld: string; respawns: number }> = [];
    const staleChildren: string[] = [];
    let respawns = 0;
    const pool = new CodexAppServerPool(1, () => {
      let childHolds: string | null = null; // null = child never started or recycled
      return {
        runTurn: async (o) => {
          // ensureStarted(): a missing child respawns now and reads the
          // CURRENT token from disk, not the one the last child held.
          if (childHolds === null) { childHolds = tokenOnDisk; respawns++; }
          served.push({ prompt: o.prompt, tokenHeld: childHolds, respawns });
          return { content: o.prompt };
        },
        close: async () => { childHolds = null; },
        // recycle(): kill the child, keep the client; the stale in-memory
        // token dies with it. Mirrors CodexAppServerClient.recycle's no-op
        // on a client with no running child.
        recycle: async () => {
          if (childHolds === null) return;
          staleChildren.push(childHolds);
          childHolds = null;
        },
      };
    });
    // Warm a child so it holds the old OAuth token in memory.
    await pool.runTurn({ ...options, prompt: 'warm' });
    await tick(); // let the pool push the finished client back to idle
    expect(served[0]).toEqual({ prompt: 'warm', tokenHeld: 'auth-v1', respawns: 1 });
    // `codex login` in another terminal: disk now has new tokens; the child
    // still holds the stale copy. Auth recovery probe follows (CodexProvider
    // recycles idle children before admitting the probe turn).
    tokenOnDisk = 'auth-v2';
    await pool.recycleIdle();
    await pool.runTurn({ ...options, prompt: 'probe' });
    expect(staleChildren).toEqual(['auth-v1']);           // stale child was killed
    expect(served[1]).toEqual({ prompt: 'probe', tokenHeld: 'auth-v2', respawns: 2 }); // fresh spawn read new credentials
    // The fresh child remains reusable — no further respawn under it.
    await pool.runTurn({ ...options, prompt: 'probe-2' });
    expect(served[2]).toEqual({ prompt: 'probe-2', tokenHeld: 'auth-v2', respawns: 2 });
    await pool.close();
    expect(respawns).toBe(2);
  });
});
