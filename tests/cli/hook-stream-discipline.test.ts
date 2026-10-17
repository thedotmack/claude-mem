import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  installHookStderrBuffer,
  emitDiagnostic,
  exitGraceful,
  emitModelContext,
  resetHookIoState,
} from '../../src/shared/hook-io.js';
import { claudeCodeAdapter } from '../../src/cli/adapters/claude-code.js';
import type { HookResult } from '../../src/cli/types.js';

// Windows Terminal tab-accumulation rationale (per CLAUDE.md):
// The exit-0-on-error policy is intentional — non-zero exits keep Windows
// Terminal tabs open. exitGraceful() exits 0 and drops buffered stderr for the
// transient worker-unavailable path. The fail-loud counter
// (recordWorkerUnreachable) writes one emitDiagnostic() line per outage and
// never exits: a worker outage must not block the user (plan-17 step 2).
//
// These tests assert the IO-discipline CONTRACT at the seam level rather than
// spawning the built worker daemon, because worker-service auto-spawns a Bun
// daemon for the `hook` subcommand (polluting the machine / flaky in CI — see
// the plan's risk table). The seam-level assertions are deterministic.

const REPO_ROOT = join(import.meta.dir, '..', '..');

function captureRealStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  return { chunks, restore: () => { process.stderr.write = original as typeof process.stderr.write; } };
}

afterEach(() => resetHookIoState());

describe('#2292 — fail-loud diagnostic is no longer swallowed', () => {
  it('emitDiagnostic surfaces the worker-unreachable message through the buffered window', () => {
    // Simulate hookCommand: install the stderr buffer that previously swallowed
    // EVERYTHING (the #2292 no-op). recordWorkerUnreachable calls
    // emitDiagnostic, which must bypass the buffer and reach real stderr.
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      // A swallowed write (what the old no-op did to library noise) stays buffered.
      process.stderr.write('library noise that should NOT surface on success\n');
      // The fail-loud path (it returns: nothing here can exit the process):
      emitDiagnostic('claude-mem worker unreachable for 3 consecutive hooks.\n');
      const surfaced = real.chunks.join('');
      expect(surfaced).toContain('claude-mem worker unreachable for 3 consecutive hooks.');
      // Library noise stays buffered; exitGraceful drops it on the way out.
      expect(surfaced).not.toContain('library noise');
    } finally {
      buffer.restore();
      real.restore();
    }
  });

  it('worker-utils recordWorkerUnreachable routes through emitDiagnostic (not emitBlockingError — source contract)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    // Worker outages must NEVER block the harness. The fail-loud branch now uses
    // emitDiagnostic (stderr-only, no exit) instead of emitBlockingError (exit 2).
    expect(src).toContain('emitDiagnostic(');
    expect(src).not.toContain('emitBlockingError(');
    expect(src).not.toMatch(/process\.stderr\.write\(\s*\n\s*`claude-mem worker unreachable/);
    expect(src).not.toMatch(/process\.exit\(2\)/);
  });

  it('claims the one-time latch under an inter-process lock before escalating', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    const start = src.indexOf('export async function recordWorkerUnreachable');
    const end = src.indexOf('function resetWorkerFailureCounter', start);
    const implementation = src.slice(start, end);

    expect(implementation).toContain('const lockToken = await acquireHookFailureLock()');
    expect(implementation).toContain('next.consecutiveFailures >= threshold && !next.thresholdTripped');
    expect(implementation).not.toContain('next.consecutiveFailures === threshold');
    expect(implementation).toContain('shouldEscalate = shouldEscalate && statePersisted');
    expect(implementation.indexOf('const statePersisted = writeHookFailureStateAtomic(next)'))
      .toBeLessThan(implementation.indexOf("await captureCliEvent('hook_failed'"));
    expect(implementation.indexOf('releaseHookFailureLock(lockToken)'))
      .toBeLessThan(implementation.indexOf("await captureCliEvent('hook_failed'"));
  });
});

describe('worker-unavailable transient path stays quiet (exit 0)', () => {
  it('exitGraceful drops buffered stderr so transient failures never leak', async () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('transient connection refused noise\n');
      await exitGraceful({ skipExit: true });
      buffer.flush();
      expect(real.chunks.join('')).toBe('');
    } finally {
      buffer.restore();
      real.restore();
    }
  });
});

describe('Edit 4A — user-message banner relocated to systemMessage (not stderr)', () => {
  it('user-message handler source no longer writes the banner to stderr', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'cli', 'handlers', 'user-message.ts'), 'utf-8');
    // No actual call (the comment mentions the API name; assert the invocation form).
    expect(src).not.toContain('process.stderr.write(');
    expect(src).toContain('systemMessage: bannerText');
  });

  it('claude-code adapter routes systemMessage to the stdout JSON envelope (banner reaches the user via contract)', () => {
    const result: HookResult = { systemMessage: 'banner-text', exitCode: 0 };
    const output = claudeCodeAdapter.formatOutput(result) as Record<string, unknown>;
    expect(output.systemMessage).toBe('banner-text');
  });
});

describe('stream separation invariant', () => {
  it('emitModelContext sends MODEL_CONTEXT to stdout (never stderr)', () => {
    const real = captureRealStderr();
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string, callback: () => void): boolean => {
      stdoutChunks.push(String(chunk));
      callback();
      return true;
    }) as typeof process.stdout.write;
    try {
      emitModelContext(claudeCodeAdapter, {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'MODEL-ONLY-PAYLOAD' },
      });
      const parsed = JSON.parse(stdoutChunks[0]) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(parsed.hookSpecificOutput?.additionalContext).toBe('MODEL-ONLY-PAYLOAD');
      // The model-bound text must not leak to stderr.
      expect(real.chunks.join('')).not.toContain('MODEL-ONLY-PAYLOAD');
    } finally {
      process.stdout.write = originalWrite;
      real.restore();
    }
  });
});
