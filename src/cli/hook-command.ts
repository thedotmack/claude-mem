import { readJsonFromStdin } from './stdin-reader.js';
import { getPlatformAdapter } from './adapters/index.js';
import { AdapterRejectedInput } from './adapters/errors.js';
import { getEventHandler } from './handlers/index.js';
import { HOOK_EXIT_CODES } from '../shared/hook-constants.js';
import { logger } from '../utils/logger.js';

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
  const output = adapter.formatOutput(result);

  console.log(JSON.stringify(output));
  const exitCode = result.exitCode ?? HOOK_EXIT_CODES.SUCCESS;
  if (!options.skipExit) {
    process.exit(exitCode);
  }
  return exitCode;
}

export async function hookCommand(platform: string, event: string, options: HookCommandOptions = {}): Promise<number> {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;

  const adapter = getPlatformAdapter(platform);
  const handler = getEventHandler(event);

  try {
    return await executeHookPipeline(adapter, handler, platform, options);
  } catch (error) {
    if (error instanceof AdapterRejectedInput) {
      logger.warn('HOOK', `Adapter rejected input (${error.reason}), skipping hook`);
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      if (!options.skipExit) {
        process.exit(HOOK_EXIT_CODES.SUCCESS);
      }
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isNonBlockingHookInputError(error)) {
      logger.warn('HOOK', `Hook input unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      if (!options.skipExit) {
        process.exit(HOOK_EXIT_CODES.SUCCESS);
      }
      return HOOK_EXIT_CODES.SUCCESS;
    }
    if (isWorkerUnavailableError(error)) {
      logger.warn('HOOK', `Worker unavailable, skipping hook: ${error instanceof Error ? error.message : error}`);
      if (!options.skipExit) {
        process.exit(HOOK_EXIT_CODES.SUCCESS);  
      }
      return HOOK_EXIT_CODES.SUCCESS;
    }

    logger.error('HOOK', `Hook error: ${error instanceof Error ? error.message : error}`, {}, error instanceof Error ? error : undefined);
    if (!options.skipExit) {
      process.exit(HOOK_EXIT_CODES.BLOCKING_ERROR);  
    }
    return HOOK_EXIT_CODES.BLOCKING_ERROR;
  } finally {
    process.stderr.write = originalStderrWrite;
  }
}
