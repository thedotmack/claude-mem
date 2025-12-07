/**
 * PreToolUse Hook - Track tool execution start
 * 
 * This hook runs before each tool execution to track timing and prepare
 * for context injection in PostToolUse.
 */

import { stdin } from 'process';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { SessionStore } from '../services/sqlite/SessionStore.js';

export interface PreToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  transcript_path: string;
  [key: string]: any;
}

// Constants
const PRE_TOOL_USE_TIMEOUT_MS = 2000;

/**
 * PreToolUse Hook Main Logic
 */
async function preToolUseHook(input?: PreToolUseInput): Promise<void> {
  if (!input) {
    logger.warn('HOOK', 'PreToolUse called with no input');
    console.log(createHookResponse('PreToolUse', true));
    process.exit(0);
  }

  const { session_id, tool_name, tool_input, transcript_path } = input;

  // Ensure worker is running
  await ensureWorkerRunning();

  const port = getWorkerPort();

  // Get session database ID
  const db = new SessionStore();
  const sessionDbId = db.createSDKSession(session_id, '', '');
  db.close();

  logger.debug('HOOK', `PreToolUse: ${tool_name}`, {
    sessionDbId,
    claudeSessionId: session_id,
    toolName: tool_name,
    transcriptPath: transcript_path
  });

  // Notify worker that a tool is about to execute
  // This can be used for tracking or preparation in the future
  try {
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/pre-tool-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        timestamp: Date.now()
      }),
      signal: AbortSignal.timeout(PRE_TOOL_USE_TIMEOUT_MS)
    });
  } catch (error) {
    // Non-critical - just tracking, don't block the hook
    // Log as info for visibility in troubleshooting
    logger.info('HOOK', 'PreToolUse notification failed (non-fatal)', { error });
  }

  console.log(createHookResponse('PreToolUse', true));
  process.exit(0);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    const parsed = input ? JSON.parse(input) : undefined;
    await preToolUseHook(parsed);
  } catch (error: any) {
    console.error(`[pre-tool-use-hook] Unhandled error: ${error.message}`);
    console.log(createHookResponse('PreToolUse', false, { reason: error.message }));
    process.exit(1);
  }
});
