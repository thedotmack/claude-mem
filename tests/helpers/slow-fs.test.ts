import { describe, expect, it } from 'bun:test';
import { runWithSlowFs } from './slow-fs.js';

describe('slow-fs harness', () => {
  it('reports a deliberate 300 ms synchronous block as at least 300 ms of lag', () => {
    const run = runWithSlowFs({
      openDelayMs: 0,
      body: `
        await new Promise(r => setTimeout(r, 30));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      `,
    });
    try {
      expect(run.maxTickGapMs).toBeGreaterThanOrEqual(300);
    } finally {
      run.cleanup();
    }
  });

  it('delays and counts opens made through a named fs import under the data dir', () => {
    const run = runWithSlowFs({
      openDelayMs: 50,
      body: `
        const { appendFileSync } = await import('fs');
        const { join } = await import('path');
        const p = join(dataDir, 'probe.txt');
        await new Promise(r => setTimeout(r, 30));
        for (let i = 0; i < 3; i++) appendFileSync(p, 'x\\n');
        return p;
      `,
    });
    try {
      expect(run.opens[run.result as string]).toBe(3);
      expect(run.blockedMs).toBe(150);
      expect(run.maxTickGapMs).toBeGreaterThanOrEqual(150);
    } finally {
      run.cleanup();
    }
  });

  it('delays async opens without blocking the event loop', () => {
    const run = runWithSlowFs({
      openDelayMs: 300,
      body: `
        const { promises } = await import('fs');
        const { join } = await import('path');
        const p = join(dataDir, 'async.txt');
        await new Promise(r => setTimeout(r, 30));
        const t0 = performance.now();
        await promises.appendFile(p, 'x\\n');
        return { p, waitedMs: performance.now() - t0 };
      `,
    });
    try {
      const { p, waitedMs } = run.result as { p: string; waitedMs: number };
      expect(run.opens[p]).toBe(1);
      expect(waitedMs).toBeGreaterThanOrEqual(300);
      expect(run.blockedMs).toBe(0);
    } finally {
      run.cleanup();
    }
  });

  it('does not delay paths outside the data dir', () => {
    const run = runWithSlowFs({
      openDelayMs: 500,
      body: `
        const { appendFileSync } = await import('fs');
        const { join } = await import('path');
        const { tmpdir } = await import('os');
        appendFileSync(join(tmpdir(), 'outside.txt'), 'x\\n');
      `,
    });
    try {
      expect(Object.keys(run.opens)).toEqual([]);
      // Deterministic: wall-clock gaps also include OS scheduling pauses on a busy runner.
      expect(run.blockedMs).toBe(0);
    } finally {
      run.cleanup();
    }
  });
});
