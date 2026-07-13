import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Sandbox DATA_DIR BEFORE importing paths/worker-utils so the fail-loud counter
// state file lands in a tmp dir and this test can drive the threshold path
// without touching the real ~/.claude-mem state. paths.ts resolves DATA_DIR from
// this env at first import, and worker-utils reads that resolved DATA_DIR.
const TMP = mkdtempSync(join(tmpdir(), 'cmem-failopen-'));
const ORIG_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
const ORIG_THRESHOLD = process.env.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD;
process.env.CLAUDE_MEM_DATA_DIR = TMP;
// Keep the fail-loud threshold at its default (3); make the intent explicit.
process.env.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD = '3';

function restoreEnv(key: string, orig: string | undefined): void {
  if (orig === undefined) delete process.env[key];
  else process.env[key] = orig;
}

afterAll(async () => {
  // Never leak our sandbox env into sibling test files (bun test shares one
  // process): restore what we found so nothing else sees the TMP overrides.
  restoreEnv('CLAUDE_MEM_DATA_DIR', ORIG_DATA_DIR);
  restoreEnv('CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD', ORIG_THRESHOLD);
  // Clean the counter state file wherever it actually landed: the TMP sandbox
  // when this file imported paths.ts first, or the real DATA_DIR when an earlier
  // suite file had already frozen the module-level DATA_DIR. Removing it just
  // resets the counter to its healthy zero default — no lasting pollution.
  try {
    const { DATA_DIR } = await import('../../src/shared/paths.js');
    rmSync(join(DATA_DIR, 'state', 'hook-failures.json'), { force: true });
  } catch { /* best-effort */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Capture real stderr by replacing the bound writer. Returns captured chunks. */
function captureRealStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  return { chunks, restore: () => { process.stderr.write = original as typeof process.stderr.write; } };
}

describe('recordWorkerUnreachable — fail-open: a memory-service outage never blocks the user', () => {
  it('never exits the process at/over the fail-loud threshold, keeps counting, and emits a loud NON-blocking notice', async () => {
    const { recordWorkerUnreachable } = await import('../../src/shared/worker-utils.js');
    const real = captureRealStderr();
    // Monotonic assertions (previous + 1) rather than absolute counts, so the
    // proof holds regardless of the starting counter value — the module-level
    // DATA_DIR may already be frozen to the real dir by an earlier suite file.
    let counts: number[] = [];
    try {
      // Under the OLD design, the call that reaches the fail-loud threshold ran
      // emitBlockingError → process.exit(2), which would kill this test process
      // mid-run (the ultimate proof of the lockout). Five calls guarantee we
      // cross the default threshold (3) and keep going PAST it; reaching every
      // assertion below proves not one of them blocked the critical path.
      for (let i = 0; i < 5; i++) counts.push(await recordWorkerUnreachable());
    } finally {
      real.restore();
    }

    // Strictly increments by 1 each call — the counter keeps working.
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBe(counts[i - 1] + 1);
    }
    // We are at/over the fail-loud threshold, and the process is still alive.
    expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(3);

    const err = real.chunks.join('');
    // Loud: the operator/model sees the degradation.
    expect(err.toLowerCase()).toContain('unreachable');
    // Reassuring + non-blocking contract surfaced to the reader.
    expect(err.toLowerCase()).toContain('not blocked');
  });
});

describe('recordWorkerUnreachable — source contract', () => {
  it('escalates via the non-blocking emitDegradedNotice, not emitBlockingError/process.exit', () => {
    const source = readFileSync('src/shared/worker-utils.ts', 'utf-8');
    const fn = source.slice(
      source.indexOf('export async function recordWorkerUnreachable'),
      source.indexOf('function resetWorkerFailureCounter'),
    );
    // Strip // comments so the contract is asserted against executable code only
    // (the explanatory comment intentionally names the old process.exit(2) path).
    const code = fn.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).toContain('emitDegradedNotice(');
    // The worker-unavailable escalation must not hard-block the critical path.
    expect(code).not.toContain('emitBlockingError(');
    expect(code).not.toContain('process.exit');
  });
});
