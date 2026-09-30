import { readJsonFromStdin } from './stdin-reader.js';
import { getPlatformAdapter } from './adapters/index.js';
import { AdapterRejectedInput } from './adapters/errors.js';
import { getEventHandler } from './handlers/index.js';
import type { HookResult } from './types.js';
import { HOOK_EXIT_CODES, isToolHookDisabledByEnv } from '../shared/hook-constants.js';
import {
  installHookStderrBuffer,
  emitModelContext,
  emitDiagnostic,
  exitGraceful,
  resetHookIoState,
} from '../shared/hook-io.js';
import {
  recordWorkerUnreachable,
  resetWorkerUnreachableState,
  setActiveHookType,
  getActiveHookType,
  isWorkerUnavailableError,
} from '../shared/worker-utils.js';
import { captureCliEvent } from '../services/telemetry/cli-telemetry.js';
import { logger } from '../utils/logger.js';

export interface HookCommandOptions {
  skipExit?: boolean;
  stdinSafetyTimeoutMs?: number;
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

export function isNonBlockingHookInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.startsWith('malformed json at stdin eof:') || lower.startsWith('incomplete json after ')) {
    return true;
  }

  return lower.includes('transcript path') &&
    (lower.includes('missing') || lower.includes('does not exist'));
}

async function executeHookPipeline(
  adapter: ReturnType<typeof getPlatformAdapter>,
  handler: ReturnType<typeof getEventHandler>,
  platform: string,
  options: HookCommandOptions
): Promise<number> {
  const rawInput = await readJsonFromStdin({ safetyTimeoutMs: options.stdinSafetyTimeoutMs });
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
  resetWorkerUnreachableState();
  // Register the hook event for the threshold-gated hook_failed telemetry
  // (closed enum enforced inside; non-enum events just omit hook_type).
  setActiveHookType(event);

  // #3106: env opt-out for the high-frequency tool hooks. Checked before stdin
  // and handler work, and still emits the no-op envelope so the host gets
  // valid JSON.
  if (isToolHookDisabledByEnv(event)) {
    const adapter = getPlatformAdapter(platform);
    emitModelContext(adapter, buildNoOpResult(event));
    exitGraceful(options);
    return HOOK_EXIT_CODES.SUCCESS;
  }

  // Hook IO Discipline (issue #2292):
  // We BUFFER stderr during handler execution so that unsolicited writes from
  // third-party libraries don't leak into model context. Every exit path drops
  // the buffer — preserving the original "quiet on success" behavior.
  //
  // To bypass the buffer for a specific write, use emitDiagnostic from
  // src/shared/hook-io.ts. Direct process.stderr.write calls are buffered.
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
      emitModelContext(adapter, buildNoOpResult(event));
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isWorkerUnavailableError(error)) {
      logger.warn('HOOK', `Worker unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      // EXIT_SIGNAL per CLAUDE.md: transient worker errors exit 0 to avoid
      // Windows Terminal tab accumulation. The fail-loud counter (worker-utils
      // recordWorkerUnreachable) never exits; when the count JUST reaches the
      // threshold it sends the hook_failed telemetry and writes a diagnostic.
      // Awaited: exitGraceful below would kill a pending POST mid-flight.
      await recordWorkerUnreachable();
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('HOOK', `Hook error: ${errorMessage}`, {}, error instanceof Error ? error : undefined);
    // plan-17 step 2 (#3161): an unexpected claude-mem error never blocks the
    // user. This path used to exit 2, which Claude Code reads as "block":
    // UserPromptSubmit dropped the prompt, PreToolUse denied the tool, and Stop
    // re-woke the agent in a loop. Every event now gets the no-op envelope and
    // exit 0; the error reaches the log, one stderr diagnostic line, and
    // telemetry. The telemetry is awaited because exitGraceful would kill a
    // pending POST mid-flight; captureCliEvent never throws and is hard-capped
    // at 2s. Closed-enum props only: the error message itself is never sent.
    // error_mode keeps its documented 'blocking_error' value so the series
    // stays continuous, even though the hook no longer blocks.
    {
      const hookType = getActiveHookType();
      await captureCliEvent('hook_failed', {
        ...(hookType !== null ? { hook_type: hookType } : {}),
        error_mode: 'blocking_error',
        threshold_tripped: false,
      });
    }
    emitDiagnostic(`claude-mem: hook error, continuing without memory: ${errorMessage}\n`);
    emitModelContext(adapter, buildNoOpResult(event));
    exitGraceful(options);
    return HOOK_EXIT_CODES.SUCCESS;
  } finally {
    stderrBuffer.restore();
  }
}

export { isWorkerUnavailableError } from '../shared/worker-utils.js';
