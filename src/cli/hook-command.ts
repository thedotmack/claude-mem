import { readJsonFromStdin } from './stdin-reader.js';
import { getPlatformAdapter } from './adapters/index.js';
import { AdapterRejectedInput } from './adapters/errors.js';
import { getEventHandler } from './handlers/index.js';
import { HOOK_EXIT_CODES } from '../shared/hook-constants.js';
import {
  installHookStderrBuffer,
  emitModelContext,
  emitBlockingError,
  exitGraceful,
  resetHookIoState,
} from '../shared/hook-io.js';
import { logger } from '../utils/logger.js';
import type { HookResult } from './types.js';

export interface HookCommandOptions {
  skipExit?: boolean;
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

export function isNonBlockingHookInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  return lower.includes('transcript path') &&
    (lower.includes('missing') || lower.includes('does not exist'));
}

function codexEventNameForHandler(event: string): string | undefined {
  switch (event) {
    case 'context':
      return 'SessionStart';
    case 'session-init':
      return 'UserPromptSubmit';
    case 'file-context':
      return 'PreToolUse';
    case 'observation':
      return 'PostToolUse';
    case 'summarize':
      return 'Stop';
    default:
      return undefined;
  }
}

export function sanitizeHookResultForPlatform(
  platform: string,
  event: string,
  result: HookResult,
): HookResult {
  if (platform !== 'codex') return result;

  const codexEventName = result.hookSpecificOutput?.hookEventName ?? codexEventNameForHandler(event);
  if (
    codexEventName !== 'PreToolUse'
    && codexEventName !== 'PermissionRequest'
    && codexEventName !== 'PostToolUse'
  ) {
    return result;
  }

  const { suppressOutput: _suppressOutput, ...rest } = result;
  return rest;
}

async function executeHookPipeline(
  adapter: ReturnType<typeof getPlatformAdapter>,
  handler: ReturnType<typeof getEventHandler>,
  platform: string,
  event: string,
  options: HookCommandOptions
): Promise<number> {
  const rawInput = await readJsonFromStdin();
  const input = adapter.normalizeInput(rawInput);
  input.platform = platform;
  const result = sanitizeHookResultForPlatform(platform, event, await handler.execute(input));

  // MODEL_CONTEXT: the only stdout JSON emit, via the platform adapter.
  emitModelContext(adapter, result);
  const exitCode = result.exitCode ?? HOOK_EXIT_CODES.SUCCESS;
  exitGraceful(options);
  return exitCode;
}

export async function hookCommand(platform: string, event: string, options: HookCommandOptions = {}): Promise<number> {
  resetHookIoState();

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
    return await executeHookPipeline(adapter, handler, platform, event, options);
  } catch (error) {
    if (error instanceof AdapterRejectedInput) {
      logger.warn('HOOK', `Adapter rejected input (${error.reason}), skipping hook`);
      emitModelContext(adapter, sanitizeHookResultForPlatform(platform, event, { continue: true, suppressOutput: true }));
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isNonBlockingHookInputError(error)) {
      logger.warn('HOOK', `Hook input unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      emitModelContext(adapter, sanitizeHookResultForPlatform(platform, event, { continue: true, suppressOutput: true }));
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isWorkerUnavailableError(error)) {
      logger.warn('HOOK', `Worker unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      // EXIT_SIGNAL per CLAUDE.md: transient worker errors exit 0 to avoid
      // Windows Terminal tab accumulation. The fail-loud counter (worker-utils
      // recordWorkerUnreachable) handles the surface-after-N-failures path.
      exitGraceful(options);
      return HOOK_EXIT_CODES.SUCCESS;
    }

    logger.error('HOOK', `Hook error: ${error instanceof Error ? error.message : error}`, {}, error instanceof Error ? error : undefined);
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
