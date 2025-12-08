/**
 * Pre-Tool-Use Hook
 *
 * Tracks tool execution start timestamps for Endless Mode.
 * Sends tool_use_id and timestamp to worker for observation correlation.
 */

import { stdin } from 'process';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';

export interface PreToolUseInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_use_id: string;
  [key: string]: any;
}

/**
 * Pre-Tool-Use Hook Main Logic
 * Non-blocking: sends timestamp to worker and returns immediately
 */
async function preToolUseHook(input?: PreToolUseInput): Promise<void> {
  if (!input) {
    throw new Error('preToolUseHook requires input');
  }

  const { session_id, tool_use_id, tool_name } = input;

  // Ensure worker is running
  await ensureWorkerRunning();

  const port = getWorkerPort();

  logger.debug('HOOK', `PreToolUse: ${tool_name}`, {
    toolUseId: tool_use_id,
    workerPort: port
  });

  try {
    // Send to worker - non-blocking, just record the timestamp
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/pre-tool-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        toolUseId: tool_use_id,
        timestamp: Date.now()
      }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to send pre-tool-use tracking', {
        status: response.status
      }, errorText);
      // Don't throw - this is tracking only, don't block tool execution
    } else {
      logger.debug('HOOK', 'Pre-tool-use tracking sent successfully', {
        toolUseId: tool_use_id
      });
    }
  } catch (error: any) {
    // Don't throw - tracking failure should not block tool execution
    logger.debug('HOOK', 'Pre-tool-use tracking failed (non-critical)', {
      error: error.message
    });
  }

  console.log(createHookResponse('PreToolUse', true));
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await preToolUseHook(parsed);
});
