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
    throw new Error(`Session cleanup failed: ${response.status}`);
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
    let parsed: SessionEndInput | undefined;
    try {
      parsed = input ? JSON.parse(input) : undefined;
    } catch (error) {
      throw new Error(`Failed to parse hook input: ${error instanceof Error ? error.message : String(error)}`);
    }
    await cleanupHook(parsed);
  });
}
