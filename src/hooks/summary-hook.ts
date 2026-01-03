/**
 * Summary Hook - Stop
 *
 * Pure HTTP client - sends data to worker, worker handles all database operations
 * including privacy checks. This allows the hook to run under any runtime
 * (Node.js or Bun) since it has no native module dependencies.
 *
 * Transcript parsing stays in the hook because only the hook has access to
 * the transcript file path.
 */

import { stdin } from 'process';
import { STANDARD_HOOK_RESPONSE } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { extractLastMessage } from '../shared/transcript-parser.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path: string;
}

/**
 * Summary Hook Main Logic - Fire-and-forget HTTP client
 */
async function summaryHook(input?: StopInput): Promise<void> {
  // Ensure worker is running before any other logic
  await ensureWorkerRunning();

  if (!input) {
    throw new Error('summaryHook requires input');
  }

  const { session_id } = input;

  const port = getWorkerPort();

  // Validate required fields before processing
  if (!input.transcript_path) {
    throw new Error(`Missing transcript_path in Stop hook input for session ${session_id}`);
  }

  // Extract last assistant message from transcript (the work Claude did)
  // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
  // The user's original request is already stored in user_prompts table.
  const lastAssistantMessage = extractLastMessage(input.transcript_path, 'assistant', true);

  logger.dataIn('HOOK', 'Stop: Requesting summary', {
    workerPort: port,
    hasLastAssistantMessage: !!lastAssistantMessage
  });

  // Send to worker - worker handles privacy check and database operations
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contentSessionId: session_id,
      last_assistant_message: lastAssistantMessage
    })
    // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
  });

  if (!response.ok) {
    console.log(STANDARD_HOOK_RESPONSE);
    throw new Error(`Summary generation failed: ${response.status}`);
  }

  logger.debug('HOOK', 'Summary request sent successfully');

  console.log(STANDARD_HOOK_RESPONSE);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    let parsed: StopInput | undefined;
    try {
      parsed = input ? JSON.parse(input) : undefined;
    } catch (error) {
      throw new Error(`Failed to parse hook input: ${error instanceof Error ? error.message : String(error)}`);
    }
    await summaryHook(parsed);
  } catch (error) {
    logger.error('HOOK', 'summary-hook failed', {}, error as Error);
  } finally {
    process.exit(0);
  }
});
