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
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';
import { handleWorkerError } from '../shared/hook-error-handler.js';
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

  // Extract last user AND assistant messages from transcript
  const transcriptPath = happy_path_error__with_fallback(
    'Missing transcript_path in Stop hook input',
    { session_id },
    input.transcript_path || ''
  );
  const lastUserMessage = extractLastMessage(transcriptPath, 'user');
  const lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);

  logger.dataIn('HOOK', 'Stop: Requesting summary', {
    workerPort: port,
    hasLastUserMessage: !!lastUserMessage,
    hasLastAssistantMessage: !!lastAssistantMessage
  });

  try {
    // Send to worker - worker handles privacy check and database operations
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        last_user_message: lastUserMessage,
        last_assistant_message: lastAssistantMessage
      }),
      signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to generate summary', {
        status: response.status
      }, errorText);
      throw new Error(`Failed to request summary from worker: ${response.status} ${errorText}`);
    }

    logger.debug('HOOK', 'Summary request sent successfully');
  } catch (error: any) {
    handleWorkerError(error);
  } finally {
    // Stop processing spinner
    try {
      const spinnerResponse = await fetch(`http://127.0.0.1:${port}/api/processing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isProcessing: false }),
        signal: AbortSignal.timeout(2000)
      });
      if (!spinnerResponse.ok) {
        logger.warn('HOOK', 'Failed to stop spinner', { status: spinnerResponse.status });
      }
    } catch (error: any) {
      logger.warn('HOOK', 'Could not stop spinner', { error: error.message });
    }
  }

  console.log(createHookResponse('Stop', true));
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await summaryHook(parsed);
});
