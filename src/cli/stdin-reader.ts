// Stdin reading utility extracted from hook patterns
// See src/hooks/save-hook.ts for the original pattern

// Timeout for stdin reading - if Claude Code doesn't close stdin within this time,
// we parse whatever data we have. This fixes issue #727 where hooks hang at "1/2 done"
// because stdin.on('end') never fires.
const STDIN_TIMEOUT_MS = 5000;

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

    // Check if we can access basic stdin properties without crashing
    // This triggers Bun's lazy initialization
    const readable = stdin.readable;
    return readable !== false;
  } catch (err) {
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
      cleanup();
      try {
        resolve(input.trim() ? JSON.parse(input) : undefined);
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    };

    // Timeout handler - resolve with whatever data we have
    // This fixes issue #727 where stdin.on('end') never fires
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolveWithData();
      }
    }, STDIN_TIMEOUT_MS);

    try {
      process.stdin.on('data', (chunk) => {
        input += chunk;
      });

      process.stdin.on('end', () => {
        clearTimeout(timeoutId);
        resolveWithData();
      });

      process.stdin.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        cleanup();
        // Don't reject on stdin errors - just return undefined
        // This is more graceful for hook execution
        resolve(undefined);
      });
    } catch (err) {
      // If attaching listeners fails (Bun stdin issue), resolve with undefined
      clearTimeout(timeoutId);
      resolve(undefined);
    }
  });
}
