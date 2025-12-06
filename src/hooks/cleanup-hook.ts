/**
 * Cleanup Hook - SessionEnd
 *
 * Pure HTTP client - sends data to worker, worker handles all database operations.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import { stdin } from 'process';
import { getWorkerPort } from '../shared/worker-utils.js';
import { silentDebug } from '../utils/silent-debug.js';

export interface SessionEndInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: string;
  reason: 'exit' | 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

/**
 * Cleanup Hook Main Logic - Fire-and-forget HTTP client
 */
async function cleanupHook(input?: SessionEndInput): Promise<void> {
  silentDebug('[cleanup-hook] Hook fired', {
    session_id: input?.session_id,
    cwd: input?.cwd,
    reason: input?.reason
  });

  // Handle standalone execution (no input provided)
  if (!input) {
    console.log('No input provided - this script is designed to run as a Claude Code SessionEnd hook');
    console.log('\nExpected input format:');
    console.log(JSON.stringify({
      session_id: "string",
      cwd: "string",
      transcript_path: "string",
      hook_event_name: "SessionEnd",
      reason: "exit"
    }, null, 2));
    process.exit(0);
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
      signal: AbortSignal.timeout(2000)
    });

    if (response.ok) {
      const result = await response.json();
      silentDebug('[cleanup-hook] Session cleanup completed', result);
    } else {
      // Non-fatal - session might not exist
      silentDebug('[cleanup-hook] Session not found or already cleaned up');
    }
  } catch (error: any) {
    // Worker might not be running - that's okay
    silentDebug('[cleanup-hook] Worker not reachable (non-critical)', {
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
