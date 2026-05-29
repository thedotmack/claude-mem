/**
 * Hook IO Discipline (issue #2292)
 *
 * This module is the ONLY place in the hook execution path that calls
 * console.log / process.stderr.write / process.exit. Every emit point declares
 * an intent and routes through here so stdout (MODEL_CONTEXT), stderr
 * (DIAGNOSTIC / USER_HINT), and exit codes (EXIT_SIGNAL / BLOCKING_FEEDBACK)
 * never get conflated.
 *
 * Intent vocabulary:
 *  - DIAGNOSTIC        operator-visible logs, never reaches the model. stderr.
 *  - MODEL_CONTEXT     content the assistant consumes. stdout JSON only.
 *  - USER_HINT         short advisory shown to the human, via HookResult.systemMessage.
 *  - BLOCKING_FEEDBACK error message the model must see (stderr + exit 2).
 *  - EXIT_SIGNAL       pure status, no payload (exit 0).
 *
 * Lives in src/shared/ (not src/cli/) so that src/shared/worker-utils.ts and
 * src/utils/logger.ts can route their stderr through emitDiagnostic without a
 * shared->cli runtime dependency. Only the HookResult / PlatformAdapter TYPES
 * are imported from src/cli, and `import type` is erased at runtime.
 */
import type { PlatformAdapter, HookResult } from '../cli/types.js';

export interface HookStderrBuffer {
  /** Write buffered bytes to real stderr, then clear the buffer. */
  flush(): void;
  /** Discard buffered bytes without writing them. */
  drop(): void;
  /** Un-replace process.stderr.write (idempotent). */
  restore(): void;
}

type StderrWriter = (chunk: string | Uint8Array) => boolean;

/**
 * The bypass channel: emitDiagnostic, emitBlockingError, and the buffer's
 * flush() all write through this so they skip the buffered window.
 *
 * - When NO buffer is installed it resolves to the live process.stderr.write
 *   (so non-hook callers — worker daemon, CLI — write straight to stderr).
 * - installHookStderrBuffer() pins it to the writer that was active at install
 *   time (the real fd writer), so flushing the buffer never re-enters the
 *   buffered writer.
 */
let pinnedBypassWrite: StderrWriter | null = null;

function bypassWrite(chunk: string | Uint8Array): boolean {
  const writer = pinnedBypassWrite
    ?? (process.stderr.write.bind(process.stderr) as StderrWriter);
  return writer(chunk);
}

let bufferedChunks: string[] | null = null;
let bufferInstalled = false;

/**
 * Replace process.stderr.write with a buffered writer. Direct
 * process.stderr.write calls (including unsolicited third-party library noise)
 * are captured into a buffer; emitDiagnostic / emitBlockingError write through
 * the bypass channel (realStderrWrite). The buffer is flushed when claude-mem
 * chooses to surface, and dropped on graceful success.
 */
export function installHookStderrBuffer(): HookStderrBuffer {
  // Pin the currently-active stderr writer as the bypass channel BEFORE we
  // replace process.stderr.write, so flush()/emitDiagnostic write to the real
  // fd and never re-enter the buffered writer.
  const realStderrWrite = process.stderr.write.bind(process.stderr) as StderrWriter;
  pinnedBypassWrite = realStderrWrite;
  bufferedChunks = [];
  bufferInstalled = true;

  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    if (bufferedChunks) {
      bufferedChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    }
    return true;
  }) as typeof process.stderr.write;

  return {
    flush(): void {
      if (bufferedChunks && bufferedChunks.length > 0) {
        realStderrWrite(bufferedChunks.join(''));
      }
      bufferedChunks = [];
    },
    drop(): void {
      bufferedChunks = [];
    },
    restore(): void {
      if (!bufferInstalled) return;
      process.stderr.write = realStderrWrite as typeof process.stderr.write;
      bufferInstalled = false;
      bufferedChunks = null;
      pinnedBypassWrite = null;
    },
  };
}

/**
 * Operator-visible diagnostic. Always reaches real stderr (bypasses the
 * buffer). Use for logger fallback, fail-loud counter, and any "we want this
 * in the operator's terminal" message. Takes a raw string; keep logger.* as
 * the structured-logging path.
 */
export function emitDiagnostic(line: string): void {
  bypassWrite(line);
}

/**
 * Emit the model-bound JSON payload to stdout. Calls adapter.formatOutput and
 * JSON.stringify exactly once. Throws if called twice in the same emitter
 * lifetime (guards against double-emit corrupting the stdout JSON stream).
 *
 * Uses console.log (not process.stdout.write) on purpose: the trailing newline
 * is what Claude Code's / Codex's hook parser expects.
 */
export function emitModelContext(adapter: PlatformAdapter, result: HookResult): void {
  if (moduleHasEmitted) {
    throw new Error('emitModelContext called twice');
  }
  moduleHasEmitted = true;
  const output = adapter.formatOutput(result);
  console.log(JSON.stringify(output));
}

let moduleHasEmitted = false;

/**
 * USER_HINT routed via the HookResult.systemMessage path. Does NOT write to a
 * stream — returns a HookResult the caller merges before emitModelContext.
 * systemMessage is platform-specific (claude-code surfaces it; codex ignores
 * it) so it must flow through the adapter, not raw stderr. If a systemMessage
 * already exists, the hint is appended with a blank line between.
 */
export function withUserHint(result: HookResult, hint: string): HookResult {
  const merged = result.systemMessage ? `${result.systemMessage}\n\n${hint}` : hint;
  return { ...result, systemMessage: merged };
}

export interface ExitOptions {
  skipExit?: boolean;
}

/**
 * BLOCKING_FEEDBACK: flush buffered stderr (so preceding diagnostics reach the
 * operator/model), write `msg` to real stderr, then exit 2 so the model
 * receives it per Claude Code's hook contract. `skipExit` is the test seam
 * that mirrors HookCommandOptions.skipExit.
 */
export function emitBlockingError(msg: string, options: ExitOptions = {}): void {
  if (bufferedChunks && bufferedChunks.length > 0) {
    bypassWrite(bufferedChunks.join(''));
    bufferedChunks = [];
  }
  bypassWrite(msg.endsWith('\n') ? msg : `${msg}\n`);
  if (!options.skipExit) {
    process.exit(2);
  }
}

/**
 * EXIT_SIGNAL: drop any buffered stderr (preserving the quiet-on-success /
 * Windows Terminal tab-management behavior) and exit 0. Caller is expected to
 * have already emitted any required stdout JSON envelope.
 */
export function exitGraceful(options: ExitOptions = {}): void {
  if (bufferedChunks) {
    bufferedChunks = [];
  }
  if (!options.skipExit) {
    process.exit(0);
  }
}

/**
 * Reset the per-invocation emit flag. hookCommand calls this at the start of
 * each invocation so the emitModelContext double-emit guard is per-hook, not
 * per-process (matters for the in-process test harness and skipExit tests).
 */
export function resetHookIoState(): void {
  moduleHasEmitted = false;
}
