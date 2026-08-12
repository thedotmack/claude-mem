
import { logger } from '../utils/logger.js';

function isStdinAvailable(): boolean {
  try {
    // Accessing process.stdin can throw on some runtimes; that is the whole
    // point of the guard.
    return !process.stdin.isTTY;
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
const TIMED_OUT = Symbol('stdin-timeout');

export async function readJsonFromStdin(): Promise<unknown> {
  if (!isStdinAvailable()) {
    return undefined;
  }

  let input = '';

  // Parse after every chunk and stop at the first complete document: hosts do
  // not always close stdin right after writing the payload.
  const read = (async () => {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (tryParseJson(input).success) break;
    }
  })().catch(() => {
    // A stdin stream error means "no input", same as the pre-async reader.
    input = '';
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), SAFETY_TIMEOUT_MS);
  });

  try {
    const raced = await Promise.race([read, timedOut]);

    const parsed = tryParseJson(input);
    if (parsed.success) return parsed.value;
    if (!input.trim()) return undefined;
    throw new Error(
      raced === TIMED_OUT
        ? `Incomplete JSON after ${SAFETY_TIMEOUT_MS}ms: ${input.slice(0, 100)}...`
        : `Malformed JSON at stdin EOF: ${input.slice(0, 100)}...`
    );
  } finally {
    clearTimeout(timer);
  }
}
