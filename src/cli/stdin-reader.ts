// Stdin reading utility extracted from hook patterns
// See src/hooks/save-hook.ts for the original pattern

// Inactivity timeout for stdin reading - if no data arrives within this time,
// we parse whatever data we have. This fixes issue #727 where hooks hang at "1/2 done"
// because stdin.on('end') never fires.
// Using inactivity timeout (reset on each data chunk) instead of absolute timeout
// to avoid truncating large/slow payloads.
const STDIN_INACTIVITY_TIMEOUT_MS = 5000;

/**
 * Check if stdin is available and readable.
 *
 * Bun has a bug where accessing process.stdin can crash with EINVAL
 * if Claude Code doesn't provide a valid stdin file descriptor (#646).
 * This function safely checks if stdin is usable.
 */
function isStdinAvailable(): boolean {
  try {
    // Accessing stdin properties can trigger Bun's lazy fstat() call
    // which crashes if the fd is invalid
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

export async function readJsonFromStdin(): Promise<unknown> {
  // First, check if stdin is even available
  // This catches the Bun EINVAL crash from issue #646
  if (!isStdinAvailable()) {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    let input = '';
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
      } catch {
        // Ignore cleanup errors
      }
    };

    const resolveWithData = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      cleanup();
      try {
        resolve(input.trim() ? JSON.parse(input) : undefined);
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    };

    // Reset the inactivity timeout - called on each data chunk
    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolveWithData();
        }
      }, STDIN_INACTIVITY_TIMEOUT_MS);
    };

    // Start initial timeout
    resetTimeout();

    try {
      process.stdin.on('data', (chunk) => {
        input += chunk;
        // Reset timeout on each data chunk to avoid truncating large/slow payloads
        resetTimeout();
      });

      process.stdin.on('end', () => {
        resolveWithData();
      });

      process.stdin.on('error', () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        cleanup();
        // Don't reject on stdin errors - just return undefined
        // This is more graceful for hook execution
        resolve(undefined);
      });
    } catch {
      // If attaching listeners fails (Bun stdin issue), resolve with undefined
      resolved = true;
      clearTimeout(timeoutId);
      cleanup();
      resolve(undefined);
    }
  });
}
