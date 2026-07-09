import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  installHookStderrBuffer,
  emitBlockingError,
  exitGraceful,
  emitModelContext,
  resetHookIoState,
} from '../../src/shared/hook-io.js';
import { claudeCodeAdapter } from '../../src/cli/adapters/claude-code.js';
import type { HookResult } from '../../src/cli/types.js';

// Windows Terminal tab-accumulation rationale (per CLAUDE.md):
// The exit-0-on-error policy is intentional — non-zero exits keep Windows
// Terminal tabs open. exitGraceful() exits 0 and drops buffered stderr for the
// transient worker-unavailable path. emitBlockingError() exits 2 only for the
// fail-loud counter (recordWorkerUnreachable) and unrecoverable handler errors.
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
  it('emitBlockingError surfaces the worker-unreachable message through the buffered window', () => {
    // Simulate hookCommand: install the stderr buffer that previously swallowed
    // EVERYTHING (the #2292 no-op). recordWorkerUnreachable now calls
    // emitBlockingError, which must bypass the buffer and reach real stderr.
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      // A swallowed write (what the old no-op did to library noise) stays buffered.
      process.stderr.write('library noise that should NOT surface on success\n');
      // The fail-loud path:
      emitBlockingError('claude-mem worker unreachable for 3 consecutive hooks.', { skipExit: true });
      const surfaced = real.chunks.join('');
      expect(surfaced).toContain('claude-mem worker unreachable for 3 consecutive hooks.');
      // and the preceding buffered noise is flushed too (operator gets full context).
      expect(surfaced).toContain('library noise');
    } finally {
      buffer.restore();
      real.restore();
    }
  });

  it('worker-utils recordWorkerUnreachable routes through emitBlockingError (source contract)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    // The fail-loud branch must NOT call process.stderr.write / process.exit directly.
    expect(src).toContain('emitBlockingError(');
    expect(src).not.toMatch(/process\.stderr\.write\(\s*\n\s*`claude-mem worker unreachable/);
  });
});

describe('#3161 — Stop hook never exits 2 on worker-unreachable', () => {
  it('emitBlockingError veto: neverBlock downgrades exit 2 to a diagnostic-only write (behavioral)', () => {
    // Single source of truth: emitBlockingError itself owns the exit-2 veto,
    // so every call site (recordWorkerUnreachable, hookCommand's catch-all)
    // inherits it by passing neverBlock instead of repeating a guard.
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    // Spy (not skipExit) so the veto itself is under test: a neverBlock
    // regression fails this assertion cleanly instead of exit-2-killing the
    // test runner.
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      emitBlockingError('worker unreachable for 3 consecutive hooks.', { neverBlock: true });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(real.chunks.join('')).toContain('worker unreachable for 3 consecutive hooks.');
    } finally {
      exitSpy.mockRestore();
      buffer.restore();
      real.restore();
    }
  });

  it('emitBlockingError veto: neverBlock drops (not flushes) buffered third-party noise, matching the pre-#3161-refactor short-circuit', () => {
    // Before centralizing the veto in emitBlockingError, the summarize branch
    // called emitDiagnostic (which never touches bufferedChunks) and returned
    // BEFORE reaching emitBlockingError's flush — so buffered noise stayed
    // silently buffered until hookCommand's finally{} discarded it. Routing
    // the summarize path through emitBlockingError unconditionally would leak
    // that noise unless neverBlock also suppresses the flush, not just exit.
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('third-party noise that must stay silent on the neverBlock path\n');
      emitBlockingError('worker unreachable for 3 consecutive hooks.', { neverBlock: true, skipExit: true });
      const surfaced = real.chunks.join('');
      expect(surfaced).not.toContain('third-party noise');
      expect(surfaced).toContain('worker unreachable for 3 consecutive hooks.');
    } finally {
      buffer.restore();
      real.restore();
    }
  });

  it('emitBlockingError still flushes buffered noise on the normal (non-neverBlock) blocking path (regression guard)', () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('buffered noise that SHOULD surface on a real blocking error\n');
      emitBlockingError('blocking message', { skipExit: true });
      const surfaced = real.chunks.join('');
      expect(surfaced).toContain('buffered noise');
      expect(surfaced).toContain('blocking message');
    } finally {
      buffer.restore();
      real.restore();
    }
  });

  it('worker-utils recordWorkerUnreachable computes neverBlock from the summarize hook type (source contract)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    const fnStart = src.indexOf('export async function recordWorkerUnreachable');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n}', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    // No local exit-2 short-circuit for summarize — the veto is delegated to
    // emitBlockingError via the neverBlock option, not duplicated here.
    expect(fnBody).toContain("neverBlock: hookType === 'summarize'");
    expect(fnBody).toContain('emitBlockingError(');
  });

  it('hookCommand catch-all delegates the summarize exemption to emitBlockingError via neverBlock (source contract)', () => {
    // The fail-loud exemption alone is not enough: non-transport errors
    // (adapter/stdin/handler throws, or a worker dying mid-response-body)
    // escape to the catch-all, which must also never exit 2 for summarize —
    // via the same neverBlock option, not a second copy of the guard.
    const src = readFileSync(join(REPO_ROOT, 'src', 'cli', 'hook-command.ts'), 'utf-8');
    const catchIdx = src.indexOf('} catch (error) {');
    expect(catchIdx).toBeGreaterThan(-1);
    const tail = src.slice(catchIdx);
    const neverBlockIdx = tail.indexOf("const neverBlock = event === 'summarize'");
    const blockIdx = tail.indexOf('emitBlockingError(');
    expect(neverBlockIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(-1);
    expect(neverBlockIdx).toBeLessThan(blockIdx);
    expect(tail.slice(blockIdx, blockIdx + 200)).toContain('neverBlock');
  });

  it('executeWithWorkerFallback handles a mid-body text() rejection as unreachable, not empty-body success (source contract)', () => {
    // A worker dying mid-body rejects text() with a plain Error whose message
    // matches no transport pattern — unguarded it escapes to the catch-all
    // (exit 2 on Stop). The success branch must catch it, record the failure,
    // and return the branded fallback — NOT swallow it into an empty-body
    // undefined "success" after resetWorkerFailureCounter has run.
    const src = readFileSync(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts'), 'utf-8');
    const fnStart = src.indexOf('export async function executeWithWorkerFallback');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart);
    // The success-branch read is wrapped so a rejection routes to the fallback.
    const readIdx = fnBody.indexOf('text = await response.text();');
    expect(readIdx).toBeGreaterThan(-1);
    const catchIdx = fnBody.indexOf('recordWorkerUnreachable()', readIdx);
    const resetIdx = fnBody.indexOf('resetWorkerFailureCounter();', readIdx);
    // recordWorkerUnreachable + branded fallback come from the read's catch,
    // BEFORE the success-path reset (which must only run once the body is read).
    expect(catchIdx).toBeGreaterThan(readIdx);
    expect(resetIdx).toBeGreaterThan(catchIdx);
    expect(fnBody.slice(catchIdx, resetIdx)).toContain('WORKER_FALLBACK_BRAND');
    // No bare unguarded read remains in the success path.
    expect(fnBody.includes('await response.text();\n  if (text.length')).toBe(false);
  });

  it('claude-code adapter maps stop_hook_active so the summarize re-entry loop breaker can fire', () => {
    const base = { session_id: 's1', cwd: process.cwd() };
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: true }).stopHookActive).toBe(true);
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: false }).stopHookActive).toBe(false);
    expect(claudeCodeAdapter.normalizeInput(base).stopHookActive).toBeUndefined();
    // Non-boolean junk never coerces (the handler checks `=== true`).
    expect(claudeCodeAdapter.normalizeInput({ ...base, stop_hook_active: 'yes' }).stopHookActive).toBeUndefined();
  });
});

describe('worker-unavailable transient path stays quiet (exit 0)', () => {
  it('exitGraceful drops buffered stderr so transient failures never leak', () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('transient connection refused noise\n');
      exitGraceful({ skipExit: true });
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
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { stdoutChunks.push(args.join(' ')); };
    try {
      emitModelContext(claudeCodeAdapter, {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'MODEL-ONLY-PAYLOAD' },
      });
      const parsed = JSON.parse(stdoutChunks[0]) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(parsed.hookSpecificOutput?.additionalContext).toBe('MODEL-ONLY-PAYLOAD');
      // The model-bound text must not leak to stderr.
      expect(real.chunks.join('')).not.toContain('MODEL-ONLY-PAYLOAD');
    } finally {
      console.log = originalLog;
      real.restore();
    }
  });
});
