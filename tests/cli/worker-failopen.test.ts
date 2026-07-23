import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const WORKER_UTILS = join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts');

describe('recordWorkerUnreachable — fail-open: a memory-service outage never blocks the user', () => {
  it('never exits the process at/over the fail-loud threshold, keeps counting, and emits a loud NON-blocking notice', () => {
    // Run in a FRESH bun process with an isolated DATA_DIR. bun shares its module
    // cache across test files, so an in-process env override can be ignored when
    // paths.ts (which resolves DATA_DIR once) was already imported by an earlier
    // suite file — that would make the calls hit and delete the REAL user counter
    // (PR #3225 review: "Cached Path Escapes Sandbox"). A subprocess gets a fresh
    // module cache, so DATA_DIR is honored and the real state is never touched.
    const TMP = mkdtempSync(join(tmpdir(), 'cmem-failopen-'));
    try {
      const code =
        `const { recordWorkerUnreachable } = await import(${JSON.stringify(WORKER_UTILS)});\n` +
        `const counts = [];\n` +
        `for (let i = 0; i < 5; i++) counts.push(await recordWorkerUnreachable());\n` +
        `process.stdout.write('COUNTS=' + JSON.stringify(counts));\n`;
      const r = spawnSync('bun', ['-e', code], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: TMP,
          CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',
        },
        timeout: 30000,
      });

      // Under the OLD design, the call reaching the threshold ran
      // emitBlockingError -> process.exit(2); the subprocess would exit 2. A clean
      // exit 0 across all five calls is the proof that a memory outage no longer
      // blocks the critical path.
      expect(r.status).toBe(0);

      const m = /COUNTS=(\[[^\]]*\])/.exec(r.stdout || '');
      expect(m).toBeTruthy();
      const counts: number[] = JSON.parse(m![1]);
      // Fresh sandbox counter starts at 0 and strictly increments by 1 each call.
      expect(counts).toEqual([1, 2, 3, 4, 5]);
      expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(3);

      const err = (r.stderr || '').toLowerCase();
      // Loud: the operator/model sees the degradation...
      expect(err).toContain('unreachable');
      // ...and it is explicitly non-blocking.
      expect(err).toContain('not blocked');

      // The counter landed in the sandbox, never the real user dir.
      const state = JSON.parse(readFileSync(join(TMP, 'state', 'hook-failures.json'), 'utf-8'));
      expect(state.consecutiveFailures).toBe(5);
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });
});

describe('recordWorkerUnreachable — source contract', () => {
  it('escalates via the non-blocking emitDegradedNotice, not emitBlockingError/process.exit', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
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
