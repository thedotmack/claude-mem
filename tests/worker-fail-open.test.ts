import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * #3184 — the fail-loud counter must FAIL OPEN by default.
 *
 * On a UserPromptSubmit hook, exit code 2 is Claude Code's "block this
 * operation" signal, so the old unconditional emitBlockingError() in
 * recordWorkerUnreachable() killed the user's command whenever the worker was
 * unreachable past the threshold. These tests exercise the real exit code by
 * invoking recordWorkerUnreachable() in an isolated subprocess (its own
 * CLAUDE_MEM_DATA_DIR), so we assert the actual process outcome rather than a
 * source-level contract.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const WORKER_UTILS = join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts');

function runRecordWorkerUnreachable(
  extraEnv: Record<string, string>
): { code: number | null; stderr: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'cmem-failopen-'));
  const script = `
    import { recordWorkerUnreachable } from ${JSON.stringify(WORKER_UTILS)};
    const n = await recordWorkerUnreachable();
    process.stderr.write('RESULT_COUNT=' + n + '\\n');
  `;
  const proc = Bun.spawnSync(['bun', '-e', script], {
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      // Trip the threshold on the very first failure.
      CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '1',
      // Keep the threshold-tripped telemetry POST from touching the network.
      CLAUDE_MEM_TELEMETRY: '0',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('#3184 — recordWorkerUnreachable fails open by default', () => {
  it('does not block (exit 0) and surfaces a non-blocking warning when the threshold trips', () => {
    const { code, stderr } = runRecordWorkerUnreachable({});
    // The crux: a tripped threshold must NOT exit 2 (which Claude Code reads as
    // "block this UserPromptSubmit").
    expect(code).toBe(0);
    // The counter still ran and returned (the process reached the tail write).
    expect(stderr).toContain('RESULT_COUNT=1');
    // The operator still gets a heads-up, just non-blocking.
    expect(stderr).toContain('Continuing without claude-mem memory context');
  });

  it('blocks (exit 2) only when CLAUDE_MEM_HOOK_FAIL_LOUD_BLOCK is opted in', () => {
    const { code, stderr } = runRecordWorkerUnreachable({
      CLAUDE_MEM_HOOK_FAIL_LOUD_BLOCK: 'true',
    });
    expect(code).toBe(2);
    expect(stderr).toContain('worker unreachable for 1 consecutive hooks');
    // emitBlockingError exits before the tail write is reached.
    expect(stderr).not.toContain('RESULT_COUNT=');
  });
});
