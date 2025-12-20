/**
 * Save Hook - PostToolUse
 *
 * PRIVACY BOUNDARY: This hook strips privacy tags before sending data to worker.
 * The worker receives pre-sanitized data and assumes tags have been removed.
 * This edge processing pattern keeps the worker service simple.
 */

import { stdin } from 'process';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { handleWorkerError } from '../shared/hook-error-handler.js';
import { handleFetchError } from './shared/error-handler.js';
import { stripMemoryTagsFromJson } from '../utils/tag-stripping.js';

export interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_response: any;
}

/**
 * Save Hook Main Logic - Fire-and-forget HTTP client
 */
async function saveHook(input?: PostToolUseInput): Promise<void> {
  // Ensure worker is running before any other logic
  await ensureWorkerRunning();

  if (!input) {
    throw new Error('saveHook requires input');
  }

  const { session_id, cwd, tool_name, tool_input, tool_response } = input;

  const port = getWorkerPort();

  const toolStr = logger.formatTool(tool_name, tool_input);

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    workerPort: port,
    sessionId: session_id,
    cwd
  });

  try {
    // PRIVACY BOUNDARY: Strip tags here at the edge before sending to worker
    // Normalize to string and strip privacy/context tags
    let cleanedToolInput = '{}';
    let cleanedToolResponse = '{}';

    try {
      const toolInputStr = typeof tool_input === 'string' ? tool_input : JSON.stringify(tool_input);
      cleanedToolInput = tool_input !== undefined
        ? stripMemoryTagsFromJson(toolInputStr)
        : '{}';
    } catch (error) {
      logger.debug('HOOK', 'Failed to serialize tool_input', { tool_name }, error);
      cleanedToolInput = '{"error": "Failed to serialize tool_input"}';
    }

    try {
      const toolResponseStr = typeof tool_response === 'string' ? tool_response : JSON.stringify(tool_response);
      cleanedToolResponse = tool_response !== undefined
        ? stripMemoryTagsFromJson(toolResponseStr)
        : '{}';
    } catch (error) {
      logger.debug('HOOK', 'Failed to serialize tool_response', { tool_name }, error);
      cleanedToolResponse = '{"error": "Failed to serialize tool_response"}';
    }

    // Send pre-sanitized data to worker
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        tool_name,
        tool_input: cleanedToolInput,
        tool_response: cleanedToolResponse,
        cwd: cwd || process.cwd()
      }),
      signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT)
    });

    if (!response.ok) {
      const errorText = await response.text();
      handleFetchError(response, errorText, {
        hookName: 'save',
        operation: 'Observation storage',
        toolName: tool_name,
        sessionId: session_id,
        port
      });
    }

    logger.debug('HOOK', 'Observation sent successfully', { toolName: tool_name });
  } catch (error: any) {
    handleWorkerError(error);
  }

  console.log(createHookResponse('PostToolUse', true));
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await saveHook(parsed);
});
