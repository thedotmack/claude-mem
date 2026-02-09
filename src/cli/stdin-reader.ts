// Stdin reading utility for Claude Code hooks
//
// Problem: Claude Code doesn't close stdin after writing hook input,
// so stdin.on('end') never fires and hooks hang indefinitely (#727).
//
// Solution: JSON is self-delimiting. We detect complete JSON by attempting
// to parse after each chunk. Once we have valid JSON, we resolve immediately
// without waiting for EOF. This is the proper fix, not a timeout workaround.

/**
 * Check if stdin is available and readable.
 *
 * Bun has a bug where accessing process.stdin can crash with EINVAL
 * if Claude Code doesn't provide a valid stdin file descriptor (#646).
 * This function safely checks if stdin is usable.
 */
function isStdinAvailable(): boolean {
  try {
    const stdin = process.stdin;

    // If stdin is a TTY, we're running interactively (not from Claude Code hook)
    if (stdin.isTTY) {
      return false;
    }

    // Accessing stdin.readable triggers Bun's lazy initialization.
    // If we get here without throwing, stdin is available.
    // Note: We don't check the value since Node/Bun don't reliably set it to false.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    stdin.readable;
    return true;
  } catch {
    // Bun crashed trying to access stdin (EINVAL from fstat)
    // This is expected when Claude Code doesn't provide valid stdin
    return false;
  }
}

/**
 * Try to parse the accumulated input as JSON.
 * Returns the parsed value if successful, undefined if incomplete/invalid.
 */
function tryParseJson(input: string): { success: true; value: unknown } | { success: false } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { success: false };
  }

  try {
    const value = JSON.parse(trimmed);
    return { success: true, value };
  } catch {
    // JSON is incomplete or invalid
    return { success: false };
  }
}

// Safety timeout - only kicks in if JSON never completes (malformed input).
// This should rarely/never be hit in normal operation since we detect complete JSON.
const SAFETY_TIMEOUT_MS = 30000;

// Short delay after last data chunk to try parsing
// This handles the case where JSON arrives in multiple chunks
const PARSE_DELAY_MS = 50;

export async function readJsonFromStdin(): Promise<unknown> {
  // First, check if stdin is even available
  // This catches the Bun EINVAL crash from issue #646
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

    // Safety timeout - fallback if JSON never completes
    const safetyTimeoutId = setTimeout(() => {
      if (!resolved) {
        // Try one final parse attempt
        if (!tryResolveWithJson()) {
          // If we have data but it's not valid JSON, that's an error
          if (input.trim()) {
            rejectWith(new Error(`Incomplete JSON after ${SAFETY_TIMEOUT_MS}ms: ${input.slice(0, 100)}...`));
          } else {
            // No data received - resolve with undefined
            resolveWith(undefined);
          }
        }
      }
    }, SAFETY_TIMEOUT_MS);

    try {
      process.stdin.on('data', (chunk) => {
        input += chunk;

        // Clear any pending parse delay
        if (parseDelayId) {
          clearTimeout(parseDelayId);
          parseDelayId = null;
        }

        // Try to parse immediately - if JSON is complete, resolve now
        if (tryResolveWithJson()) {
          return;
        }

        // If immediate parse failed, set a short delay and try again
        // This handles multi-chunk delivery where the last chunk completes the JSON
        parseDelayId = setTimeout(() => {
          tryResolveWithJson();
        }, PARSE_DELAY_MS);
      });

      process.stdin.on('end', () => {
        // stdin closed - parse whatever we have
        if (!resolved) {
          if (!tryResolveWithJson()) {
            // Empty or invalid - resolve with undefined
            resolveWith(input.trim() ? undefined : undefined);
          }
        }
      });

      process.stdin.on('error', () => {
        if (!resolved) {
          // Don't reject on stdin errors - just return undefined
          // This is more graceful for hook execution
          resolveWith(undefined);
        }
      });
    } catch {
      // If attaching listeners fails (Bun stdin issue), resolve with undefined
      resolved = true;
      clearTimeout(safetyTimeoutId);
      cleanup();
      resolve(undefined);
    }
  });
}
