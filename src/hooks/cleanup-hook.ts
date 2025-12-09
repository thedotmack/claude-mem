/**
 * Cleanup Hook - SessionEnd
 *
 * Pure HTTP client - sends data to worker, worker handles all database operations.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import { stdin } from 'process';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';

export interface SessionEndInput {
  session_id: string;
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

/**
 * Cleanup Hook Main Logic - Fire-and-forget HTTP client
 */
async function cleanupHook(input?: SessionEndInput): Promise<void> {
  // Ensure worker is running before any other logic
  await ensureWorkerRunning();

  happy_path_error__with_fallback('[cleanup-hook] Hook fired', {
    session_id: input?.session_id,
    reason: input?.reason
  });

  if (!input) {
    throw new Error('cleanup-hook requires input from Claude Code');
  }

  const { session_id, reason } = input;

  const port = getWorkerPort();

  try {
    // Send to worker - worker handles finding session, marking complete, and stopping spinner
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        reason
      }),
      signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT)
    });

    if (response.ok) {
      const result = await response.json();
      happy_path_error__with_fallback('[cleanup-hook] Session cleanup completed', result);
    } else {
      // Non-fatal - session might not exist
      happy_path_error__with_fallback('[cleanup-hook] Session not found or already cleaned up');
    }
  } catch (error: any) {
    // Worker might not be running - that's okay
    happy_path_error__with_fallback('[cleanup-hook] Worker not reachable (non-critical)', {
      error: error.message
    });
  }

  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}

// Entry Point
if (stdin.isTTY) {
  // Running manually
  cleanupHook(undefined);
} else {
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', async () => {
    const parsed = input ? JSON.parse(input) : undefined;
    await cleanupHook(parsed);
  });
}
