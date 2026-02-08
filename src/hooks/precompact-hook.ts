/**
 * PreCompact Hook - Triggered before context compaction
 *
 * Creates a handoff observation to preserve critical session state
 * before context is compacted, ensuring continuity across compactions.
 *
 * Inspired by Continuous Claude v2's handoff pattern.
 */

import { stdin } from 'process';
import { STANDARD_HOOK_RESPONSE } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { extractLastMessage } from '../shared/transcript-parser.js';

export interface PreCompactInput {
  session_id: string;
  transcript_path: string;
  permission_mode: string;
  hook_event_name: string;
  trigger: 'manual' | 'auto';
  custom_instructions: string;
}

/**
 * PreCompact Hook Main Logic
 *
 * Creates a handoff observation with:
 * - Current session context
 * - Active tasks/goals
 * - Key decisions made
 * - Files being worked on
 * - Resume instructions for post-compaction
 */
async function precompactHook(input?: PreCompactInput): Promise<void> {
  // Ensure worker is running
  await ensureWorkerRunning();

  if (!input) {
    throw new Error('precompactHook requires input');
  }

  const { session_id, transcript_path, trigger, custom_instructions } = input;
  const port = getWorkerPort();

  logger.info('HOOK', `PreCompact triggered (${trigger})`, {
    workerPort: port,
    hasCustomInstructions: !!custom_instructions
  });

  // Extract last messages from transcript for context
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;

  if (transcript_path) {
    try {
      lastUserMessage = extractLastMessage(transcript_path, 'user');
      lastAssistantMessage = extractLastMessage(transcript_path, 'assistant', true);
    } catch (error) {
      logger.warn('HOOK', 'Could not extract last messages from transcript', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Send handoff request to worker
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claudeSessionId: session_id,
      trigger,
      customInstructions: custom_instructions,
      lastUserMessage,
      lastAssistantMessage
    }),
    signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT)
  });

  if (!response.ok) {
    // Non-fatal: log warning but don't block compaction
    logger.warn('HOOK', `Handoff creation failed: ${response.status}`);
  } else {
    const result = await response.json();
    logger.info('HOOK', 'Handoff observation created successfully', {
      handoffId: result.handoffId,
      tasksPreserved: result.tasksCount
    });
  }

  console.log(STANDARD_HOOK_RESPONSE);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  let parsed: PreCompactInput | undefined;
  try {
    parsed = input ? JSON.parse(input) : undefined;
  } catch (error) {
    // Log error but don't block compaction
    console.error(`Failed to parse PreCompact hook input: ${error instanceof Error ? error.message : String(error)}`);
    console.log(STANDARD_HOOK_RESPONSE);
    return;
  }

  try {
    await precompactHook(parsed);
  } catch (error) {
    // Log error but don't block compaction
    console.error(`PreCompact hook error: ${error instanceof Error ? error.message : String(error)}`);
    console.log(STANDARD_HOOK_RESPONSE);
  }
});
