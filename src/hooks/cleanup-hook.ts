/**
 * Cleanup Hook - SessionEnd
 *
 * Pure HTTP client - sends data to worker, worker handles all database operations.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import { stdin } from 'process';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
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

    if (!response.ok) {
      // Non-fatal - session might not exist
      console.error('[cleanup-hook] Session not found or already cleaned up');
    }
  } catch (error: any) {
    // Worker might not be running - that's okay (non-critical)
  }

  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await cleanupHook(parsed);
});
