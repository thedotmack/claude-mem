/**
 * Cleanup Hook - SessionEnd
 *
 * Tells the worker a Claude Code session has ended so it can abort the SDK
 * agent and release the `claude` subprocess that SDKAgent keeps alive for the
 * lifetime of the session.
 *
 * Without this hook nothing ever calls SessionManager.deleteSession() in normal
 * operation, so every session leaks a ~400MB subprocess until the machine is
 * rebooted. See the comment on handleCompleteByClaudeId in SessionRoutes.
 *
 * Pure HTTP client, like the other hooks - the worker owns all database work.
 */

import { stdin } from 'process';
import { STANDARD_HOOK_RESPONSE } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { getWorkerPort } from '../shared/worker-utils.js';

export interface SessionEndInput {
  session_id: string;
  cwd?: string;
  reason?: string;
}

/**
 * Cleanup Hook Main Logic
 *
 * NOTE: deliberately does NOT call ensureWorkerRunning(). The other hooks start
 * the worker because they have data to deliver; this one only asks it to shut a
 * session down. Booting a worker just to tell it about a session it never had
 * would leak the very process this hook exists to reclaim.
 */
async function cleanupHook(input?: SessionEndInput): Promise<void> {
  if (!input) {
    throw new Error('cleanupHook requires input');
  }

  const { session_id } = input;

  if (!session_id) {
    logger.debug('HOOK', 'SessionEnd: no session_id, nothing to clean up');
    console.log(STANDARD_HOOK_RESPONSE);
    return;
  }

  const port = getWorkerPort();

  logger.dataIn('HOOK', 'SessionEnd: Requesting session completion', {
    workerPort: port,
    reason: input.reason
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentSessionId: session_id })
  });

  if (!response.ok) {
    console.log(STANDARD_HOOK_RESPONSE);
    throw new Error(`Session completion failed: ${response.status}`);
  }

  logger.debug('HOOK', 'Session completion request sent successfully');

  console.log(STANDARD_HOOK_RESPONSE);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    let parsed: SessionEndInput | undefined;
    try {
      parsed = input ? JSON.parse(input) : undefined;
    } catch (error) {
      throw new Error(`Failed to parse hook input: ${error instanceof Error ? error.message : String(error)}`);
    }
    await cleanupHook(parsed);
  } catch (error) {
    // Never block session teardown: a failed cleanup is logged, not surfaced.
    logger.error('HOOK', 'cleanup-hook failed', {}, error as Error);
  } finally {
    process.exit(0);
  }
});
