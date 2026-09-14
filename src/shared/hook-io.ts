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
import { Console } from 'node:console';
import { Writable } from 'node:stream';
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

export interface HookStdoutGuard {
  /** Un-replace process.stdout.write and the stdout-bound console methods (idempotent). */
  restore(): void;
}

type StdoutWriter = (chunk: string | Uint8Array) => boolean;

let pinnedStdoutWrite: StdoutWriter | null = null;
let stdoutGuardInstalled = false;

/**
 * The console members that print to stdout. warn/error/trace/assert already
 * go to stderr, so they are left alone. The state-carrying members are swapped
 * as a set with the members that print that state, so a `groupEnd` always
 * finds the `group` that opened it and a `timeEnd` the `time` that started it.
 */
const STDOUT_CONSOLE_METHODS = [
  'log', 'info', 'debug', 'dir', 'dirxml', 'table',
  'group', 'groupCollapsed', 'groupEnd',
  'count', 'countReset',
  'time', 'timeEnd', 'timeLog',
] as const;

type ConsoleLike = Record<string, (...args: unknown[]) => unknown>;

/**
 * Reserve stdout for the ONE model-bound JSON payload.
 *
 * The stderr buffer above exists because third-party libraries write
 * unsolicited noise to stderr. They do it to stdout too, and there it is not
 * noise but corruption: Claude Code reads a hook's stdout as a single JSON
 * object, so one extra line ahead of the payload makes the whole buffer
 * unparseable and the hook fails with "Hook output looks like a JSON object
 * but is not valid JSON" (#4081 -- an NDJSON environment banner from
 * somewhere inside the bundled worker, which the reporter could not locate by
 * grepping the bundle and could not reproduce outside the real hook path).
 *
 * So this does not try to find the emitter. It makes the emitter irrelevant:
 * anything written to stdout during the hook window is DIVERTED to stderr,
 * and `emitModelContext` writes its payload through the pinned real writer.
 *
 * Two writers have to be covered, not one. Replacing process.stdout.write is
 * enough on Node, where console.log is a thin wrapper over it, but hooks run
 * under Bun and Bun's console writes to fd 1 natively -- a replaced
 * process.stdout.write never sees console.log (measured on Bun 1.4.2, pinned
 * by a test). So the stdout-bound console members are re-bound to a
 * node:console Console whose stdout is the diverting sink; that keeps %s/%d
 * formatting, util.inspect output and group indentation byte-identical
 * instead of reimplementing them here.
 *
 * Diverted, not dropped, and diverted through the LIVE process.stderr.write
 * rather than the bypass channel: when installHookStderrBuffer is also
 * installed the noise lands in that buffer and gets the policy third-party
 * stderr noise already has -- dropped on graceful success, flushed when
 * claude-mem surfaces. Corrupting the payload is the bug; where the noise
 * goes afterwards stays one decision, made in one place.
 */
export function installHookStdoutGuard(): HookStdoutGuard {
  const realStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutWriter;
  pinnedStdoutWrite = realStdoutWrite;
  stdoutGuardInstalled = true;

  const divert = (chunk: string | Uint8Array, encoding?: BufferEncoding): boolean => {
    // An explicit encoding describes the BYTES a string chunk stands for
    // (`write(base64Text, 'base64')` writes the decoded bytes), so it has to
    // be honoured before the text is handed to stderr. It says nothing about a
    // Uint8Array chunk, which is already bytes.
    const text =
      typeof chunk === 'string'
        ? encoding && encoding !== 'utf8' && encoding !== 'utf-8'
          ? Buffer.from(chunk, encoding).toString('utf-8')
          : chunk
        : Buffer.from(chunk).toString('utf-8');
    process.stderr.write(text);
    return true;
  };

  // Both overloads, callback included. `write(chunk, cb)` and
  // `write(chunk, encoding, cb)` promise the caller that cb fires when the
  // write completes; a replacement that swallowed it would leave anything
  // waiting on write completion waiting for good. On nextTick rather than
  // inline, because the stream contract is that the callback runs after
  // write() has returned.
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean => {
    const callback =
      typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback;
    const encoding =
      typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const wrote = divert(chunk, encoding);
    if (callback) {
      process.nextTick(callback);
    }
    return wrote;
  }) as typeof process.stdout.write;

  // The sink is a real stream.Writable because Bun's node:console rejects a
  // bare { write } object. It completes every write synchronously, so nothing
  // is left queued when the hook exits.
  const sink = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      divert(chunk);
      callback();
    },
  });
  const divertedConsole = new Console({ stdout: sink, stderr: sink }) as unknown as ConsoleLike;
  const liveConsole = console as unknown as ConsoleLike;
  const originalConsoleMethods = new Map<string, (...args: unknown[]) => unknown>();
  for (const name of STDOUT_CONSOLE_METHODS) {
    const replacement = divertedConsole[name];
    const original = liveConsole[name];
    if (typeof replacement !== 'function' || typeof original !== 'function') continue;
    originalConsoleMethods.set(name, original);
    liveConsole[name] = replacement.bind(divertedConsole);
  }

  return {
    restore(): void {
      if (!stdoutGuardInstalled) return;
      process.stdout.write = realStdoutWrite as typeof process.stdout.write;
      for (const [name, original] of originalConsoleMethods) {
        liveConsole[name] = original;
      }
      stdoutGuardInstalled = false;
      pinnedStdoutWrite = null;
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
 * The trailing newline is what Claude Code's / Codex's hook parser expects,
 * which is why this used to be console.log. It now writes the same bytes
 * through the writer `installHookStdoutGuard` pinned, so the payload is the
 * one thing the guard does NOT divert -- with a guard installed console.log
 * is a re-bound method that writes to the diverting sink, so the payload
 * would land on stderr with the noise. Falls back to console.log when no
 * guard is installed (non-hook callers, and every existing test that calls
 * this directly).
 */
export function emitModelContext(adapter: PlatformAdapter, result: HookResult): void {
  if (moduleHasEmitted) {
    throw new Error('emitModelContext called twice');
  }
  moduleHasEmitted = true;
  const output = adapter.formatOutput(result);
  const line = JSON.stringify(output);
  if (pinnedStdoutWrite) {
    pinnedStdoutWrite(`${line}\n`);
    return;
  }
  console.log(line);
}

let moduleHasEmitted = false;

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
