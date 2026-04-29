
import { logger } from '../utils/logger.js';

function isStdinAvailable(): boolean {
  try {
    const stdin = process.stdin;

    if (stdin.isTTY) {
      return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    stdin.readable;
    return true;
  } catch (error) {
    logger.debug('HOOK', 'stdin not available (expected for some runtimes)', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function tryParseJson(input: string): { success: true; value: unknown } | { success: false } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { success: false };
  }

  try {
    const value = JSON.parse(trimmed);
    return { success: true, value };
  } catch (error) {
    logger.debug('HOOK', 'JSON parse attempt incomplete', { error: error instanceof Error ? error.message : String(error) });
    return { success: false };
  }
}

const SAFETY_TIMEOUT_MS = 30000;

const PARSE_DELAY_MS = 50;

export async function readJsonFromStdin(): Promise<unknown> {
  if (!isStdinAvailable()) {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    let input = '';
    let resolved = false;
    let parseDelayId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
      } catch {
        // Ignore cleanup errors
      }
    };

    const resolveWith = (value: unknown) => {
      if (resolved) return;
      resolved = true;
      if (parseDelayId) clearTimeout(parseDelayId);
      clearTimeout(safetyTimeoutId);
      cleanup();
      resolve(value);
    };

    const rejectWith = (error: Error) => {
      if (resolved) return;
      resolved = true;
      if (parseDelayId) clearTimeout(parseDelayId);
      clearTimeout(safetyTimeoutId);
      cleanup();
      reject(error);
    };

    const tryResolveWithJson = () => {
      const result = tryParseJson(input);
      if (result.success) {
        resolveWith(result.value);
        return true;
      }
      return false;
    };

    const safetyTimeoutId = setTimeout(() => {
      if (!resolved) {
        if (!tryResolveWithJson()) {
          if (input.trim()) {
            rejectWith(new Error(`Incomplete JSON after ${SAFETY_TIMEOUT_MS}ms: ${input.slice(0, 100)}...`));
          } else {
            resolveWith(undefined);
          }
        }
      }
    }, SAFETY_TIMEOUT_MS);

    const onData = (chunk: Buffer | string) => {
      input += chunk;

      if (parseDelayId) {
        clearTimeout(parseDelayId);
        parseDelayId = null;
      }

      if (tryResolveWithJson()) {
        return;
      }

      parseDelayId = setTimeout(() => {
        tryResolveWithJson();
      }, PARSE_DELAY_MS);
    };

    const onEnd = () => {
      if (!resolved) {
        if (!tryResolveWithJson()) {
          if (input.trim()) {
            rejectWith(new Error(`Malformed JSON at stdin EOF: ${input.slice(0, 100)}...`));
          } else {
            resolveWith(undefined);
          }
        }
      }
    };

    const onError = () => {
      if (!resolved) {
        resolveWith(undefined);
      }
    };

    try {
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.on('error', onError);
    } catch (error) {
      logger.debug('HOOK', 'Failed to attach stdin listeners', { error: error instanceof Error ? error.message : String(error) });
      resolved = true;
      clearTimeout(safetyTimeoutId);
      cleanup();
      resolve(undefined);
    }
  });
}
