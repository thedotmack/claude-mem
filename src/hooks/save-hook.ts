/**
 * Save Hook - PostToolUse
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { silentDebug } from '../utils/silent-debug.js';
import { stripMemoryTagsFromJson } from '../utils/tag-stripping.js';

export interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_response: any;
  [key: string]: any;
}

// Tools to skip (low value or too frequent)
const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool',  // MCP infrastructure
  'SlashCommand',          // Command invocation (observe what it produces, not the call)
  'Skill',                 // Skill invocation (observe what it produces, not the call)
  'TodoWrite',             // Task management meta-tool
  'AskUserQuestion'        // User interaction, not substantive work
]);


/**
 * Save Hook Main Logic
 */
async function saveHook(input?: PostToolUseInput): Promise<void> {
  if (!input) {
    throw new Error('saveHook requires input');
  }

  const { session_id, cwd, tool_name, tool_input, tool_response } = input;

  if (SKIP_TOOLS.has(tool_name)) {
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  // Ensure worker is running
  await ensureWorkerRunning();

  const db = new SessionStore();

  // Get or create session
  const sessionDbId = db.createSDKSession(session_id, '', '');
  const promptNumber = db.getPromptCounter(sessionDbId);

  // Skip observation if user prompt was entirely private
  // This respects the user's intent: if they marked the entire prompt as <private>,
  // they don't want ANY observations from that interaction
  const userPrompt = db.getUserPrompt(session_id, promptNumber);
  if (!userPrompt || userPrompt.trim() === '') {
    silentDebug('[save-hook] Skipping observation - user prompt was entirely private', {
      session_id,
      promptNumber,
      tool_name
    });
    db.close();
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  db.close();

  const toolStr = logger.formatTool(tool_name, tool_input);

  const port = getWorkerPort();

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    sessionId: sessionDbId,
    workerPort: port
  });

  try {
    // Serialize and strip memory tags from tool_input and tool_response
    // This prevents recursive storage of context and respects <private> tags
    let cleanedToolInput = '{}';
    let cleanedToolResponse = '{}';

    try {
      cleanedToolInput = tool_input !== undefined
        ? stripMemoryTagsFromJson(JSON.stringify(tool_input))
        : '{}';
    } catch (error) {
      // Handle circular references or other JSON.stringify errors
      silentDebug('[save-hook] Failed to stringify tool_input:', { error, tool_name });
      cleanedToolInput = '{"error": "Failed to serialize tool_input"}';
    }

    try {
      cleanedToolResponse = tool_response !== undefined
        ? stripMemoryTagsFromJson(JSON.stringify(tool_response))
        : '{}';
    } catch (error) {
      // Handle circular references or other JSON.stringify errors
      silentDebug('[save-hook] Failed to stringify tool_response:', { error, tool_name });
      cleanedToolResponse = '{"error": "Failed to serialize tool_response"}';
    }

    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        tool_input: cleanedToolInput,
        tool_response: cleanedToolResponse,
        prompt_number: promptNumber,
        cwd: cwd || ''
      }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to send observation', {
        sessionId: sessionDbId,
        status: response.status
      }, errorText);
      throw new Error(`Failed to send observation to worker: ${response.status} ${errorText}`);
    }

    logger.debug('HOOK', 'Observation sent successfully', { sessionId: sessionDbId, toolName: tool_name });
  } catch (error: any) {
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    // Re-throw HTTP errors and other errors as-is
    throw error;
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
