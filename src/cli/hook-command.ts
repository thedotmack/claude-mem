import { readJsonFromStdin, HookInputUnreadable } from './stdin-reader.js';
import { getPlatformAdapter } from './adapters/index.js';
import { AdapterRejectedInput } from './adapters/errors.js';
import { getEventHandler } from './handlers/index.js';
import type { HookResult } from './types.js';
import { HOOK_EXIT_CODES } from '../shared/hook-constants.js';
import {
  installHookStderrBuffer,
  emitModelContext,
  emitBlockingError,
  exitGraceful,
  resetHookIoState,
} from '../shared/hook-io.js';
import {
  recordWorkerUnreachable,
  setActiveHookType,
  getActiveHookType,
} from '../shared/worker-utils.js';
import { captureCliEvent } from '../services/telemetry/cli-telemetry.js';
import { logger } from '../utils/logger.js';

export interface HookCommandOptions {
  skipExit?: boolean;
}

/**
 * How long the fail-open path will wait for its telemetry POST.
 *
 * Short on purpose. `UserPromptSubmit` and `SessionStart` are synchronous, so
 * every millisecond here is a millisecond the user waits — and this branch
 * exists precisely to stop a hook that cannot read its stdin from costing them
 * anything.
 */
export const NON_BLOCKING_TELEMETRY_DEADLINE_MS = 250;

/**
 * Resolve when `work` settles or when `ms` elapses, whichever is first.
 *
 * The abandoned promise is not cancelled — `captureCliEvent` never throws and
 * never has a caller waiting on its result, so leaving it in flight until
 * `process.exit` is exactly as harmless as the fire-and-forget it replaces.
 */
export async function raceDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, ms);
        // Do not hold the event loop open for a deadline nobody is waiting on.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * No-op result for hooks that must exit before their handler ran (adapter
 * rejected input, transcript path missing). `context` is the sole handler
 * key that produces SessionStart output on every platform; a bare
 * `{continue:true}` fallback for it — with no hookSpecificOutput — is what
 * Codex's strict SessionStart validator rejects as "invalid session start
 * JSON output" (issue #2972). Attaching the minimal valid payload keeps the
 * no-op harmless everywhere else too.
 */
export function buildNoOpResult(event: string): HookResult {
  const result: HookResult = { continue: true, suppressOutput: true };
  if (event === 'context') {
    result.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: '' };
  }
  return result;
}

export function isWorkerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  const transportPatterns = [
    'econnrefused',
    'econnreset',
    'epipe',
    'etimedout',
    'enotfound',
    'econnaborted',
    'enetunreach',
    'ehostunreach',
    'fetch failed',
    'unable to connect',
    'socket hang up',
  ];
  if (transportPatterns.some(p => lower.includes(p))) return true;

  if (lower.includes('timed out') || lower.includes('timeout')) return true;

  if (/failed:\s*5\d{2}/.test(message) || /status[:\s]+5\d{2}/.test(message)) return true;

  if (/failed:\s*429/.test(message) || /status[:\s]+429/.test(message)) return true;

  if (/failed:\s*4\d{2}/.test(message) || /status[:\s]+4\d{2}/.test(message)) return false;

  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return false;
  }

  return false;
}

/**
 * True when the hook could not obtain its own input — stdin never arrived as
 * parseable JSON, or the transcript it was pointed at is gone.
 *
 * These must never exit non-zero. `UserPromptSubmit` and `SessionStart` are
 * the two hooks in hooks.json registered WITHOUT `"async": true`, so Claude
 * Code reads their real exit status instead of synthesising 0. On
 * UserPromptSubmit an exit of 2 blocks the submission and discards the typed
 * prompt, which is a far worse outcome than the missed observation that
 * failing open costs us (#3699).
 */
export function isNonBlockingHookInputError(error: unknown): boolean {
  if (error instanceof HookInputUnreadable) return true;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  return lower.includes('transcript path') &&
    (lower.includes('missing') || lower.includes('does not exist'));
}

async function executeHookPipeline(
  adapter: ReturnType<typeof getPlatformAdapter>,
  handler: ReturnType<typeof getEventHandler>,
  platform: string,
  options: HookCommandOptions
): Promise<number> {
  const rawInput = await readJsonFromStdin();
  const input = adapter.normalizeInput(rawInput);
  input.platform = platform;
  const result = await handler.execute(input);

  // MODEL_CONTEXT: the only stdout JSON emit, via the platform adapter.
  emitModelContext(adapter, result);
  const exitCode = result.exitCode ?? HOOK_EXIT_CODES.SUCCESS;
  exitGraceful(options);
  return exitCode;
}

export async function hookCommand(platform: string, event: string, options: HookCommandOptions = {}): Promise<number> {
  resetHookIoState();
  // Register the hook event for the threshold-gated hook_failed telemetry
  // (closed enum enforced inside; non-enum events just omit hook_type).
  setActiveHookType(event);

  // Hook IO Discipline (issue #2292):
  // We BUFFER stderr during handler execution so that unsolicited writes from
  // third-party libraries don't leak into model context. The buffer is FLUSHED
  // only when we choose to surface (logger errors at the catch-all branch,
  // fail-loud counter from worker-utils, blocking-error path). Successful exits
  // drop the buffer — preserving the original "quiet on success" behavior.
  //
  // To bypass the buffer for a specific write, use emitDiagnostic /
  // emitBlockingError from src/shared/hook-io.ts. Direct process.stderr.write
  // calls are buffered.
  const stderrBuffer = installHookStderrBuffer();

  const adapter = getPlatformAdapter(platform);
  const handler = getEventHandler(event);

  try {
    return await executeHookPipeline(adapter, handler, platform, options);
  } catch (error) {
    if (error instanceof AdapterRejectedInput) {
      logger.warn('HOOK', `Adapter rejected input (${error.reason}), skipping hook`);
      emitModelContext(adapter, buildNoOpResult(event));
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isNonBlockingHookInputError(error)) {
      logger.warn('HOOK', `Hook input unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      // Answer FIRST, report second. This branch exists so a hook that cannot
      // read its own stdin never costs the user their prompt, and holding the
      // response for a telemetry POST would reintroduce that cost in seconds
      // instead of in a blocked submission.
      emitModelContext(adapter, buildNoOpResult(event));
      // Failing open here used to be failing SILENT: before #3699 an
      // unreadable stdin fell through to the catch-all, which emitted
      // hook_failed. The signal is kept, but on a leash — captureCliEvent is
      // capped at 2s internally, which is 2s this particular hook does not
      // have. Past the deadline the event is abandoned: one lost data point,
      // against a UserPromptSubmit that stalls on every malformed stdin.
      {
        const hookType = getActiveHookType();
        await raceDeadline(
          captureCliEvent('hook_failed', {
            ...(hookType !== null ? { hook_type: hookType } : {}),
            error_mode: 'input_unavailable',
            threshold_tripped: false,
          }),
          NON_BLOCKING_TELEMETRY_DEADLINE_MS,
        );
      }
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isWorkerUnavailableError(error)) {
      logger.warn('HOOK', `Worker unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      // EXIT_SIGNAL per CLAUDE.md: transient worker errors exit 0 to avoid
      // Windows Terminal tab accumulation. The fail-loud counter (worker-utils
      // recordWorkerUnreachable) handles the surface-after-N-failures path and
      // emits the threshold-gated hook_failed telemetry internally. Awaited:
      // when the count JUST reaches the threshold it sends the event and then
      // exits 2; exitGraceful below would kill a pending POST mid-flight.
      await recordWorkerUnreachable();
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }

    logger.error('HOOK', `Hook error: ${error instanceof Error ? error.message : error}`, {}, error instanceof Error ? error : undefined);
    // hook_failed telemetry MUST be awaited BEFORE emitBlockingError — it
    // calls process.exit(2), which would kill a fire-and-forget POST
    // mid-flight. captureCliEvent never throws and is hard-capped at 2s.
    // Closed-enum props only: the error message itself is never sent.
    {
      const hookType = getActiveHookType();
      await captureCliEvent('hook_failed', {
        ...(hookType !== null ? { hook_type: hookType } : {}),
        error_mode: 'blocking_error',
        threshold_tripped: false,
      });
    }
    // BLOCKING_FEEDBACK: flush the buffered logger.error line to stderr and
    // exit 2 so the model receives it per Claude Code's hook contract.
    emitBlockingError(
      `Hook error: ${error instanceof Error ? error.message : String(error)}`,
      options,
    );
    return HOOK_EXIT_CODES.BLOCKING_ERROR;
  } finally {
    stderrBuffer.restore();
  }
}
