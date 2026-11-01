import { describe, it, expect } from 'bun:test';
import { CodexAppServerPool, boundedInteger } from '../../src/services/worker/CodexAppServerPool.js';
const options = { codexPath: 'codex', model: '', reasoningEffort: null, timeoutMs: 1000, prompt: '' };
function harness() {
  const started: string[] = [];
  const finish: Array<() => void> = [];
  let busy = 0, peak = 0, closed = 0;
  const pool = new CodexAppServerPool(2, () => ({
    runTurn: async (o) => {
      started.push(o.prompt); busy++; peak = Math.max(peak, busy);
      try { return await new Promise<{content: string}>((resolve, reject) => {
        finish.push(() => resolve({ content: o.prompt }));
        o.signal?.addEventListener('abort', () => reject(o.signal!.reason), { once: true });
      }); } finally { busy--; }
    }, close: async () => { closed++; },
  }));
  return { pool, started, finish, stats: () => ({ busy, peak, closed }) };
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
});
