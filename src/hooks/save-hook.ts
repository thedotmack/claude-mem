/**
 * Save Hook - PostToolUse
 *
 * Pure HTTP client - sends data to worker, worker handles all database operations
 * including privacy checks. This allows the hook to run under any runtime
 * (Node.js or Bun) since it has no native module dependencies.
 *
 * Endless Mode (v7.1): Waits for observations and injects via additionalContext
 */

import { stdin } from 'process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { formatObservationAsMarkdown } from './context-injection.js';
import { clearToolInputInTranscript } from './context-injection.js';

export interface PostToolUseInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_response: any;
  tool_use_id?: string;  // For Endless Mode v7.1 observation correlation
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
 * Load Endless Mode configuration from settings
 */
function loadEndlessModeConfig(): { enabled: boolean } {
  try {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settingsData = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsData);
    const env = settings.env || {};

    return {
      enabled: env.CLAUDE_MEM_ENDLESS_MODE === 'true'
    };
  } catch (error) {
    // If settings file doesn't exist, use defaults (disabled)
    return { enabled: false };
  }
}

/**
 * Save Hook Main Logic - Synchronous observation processing for Endless Mode
 */
async function saveHook(input?: PostToolUseInput): Promise<void> {
  if (!input) {
    throw new Error('saveHook requires input');
  }

  // Log all available parameters
  console.error(`[SAVE-HOOK] Parameters received: ${JSON.stringify(Object.keys(input))}`);

  const { session_id, cwd, tool_name, tool_input, tool_response } = input;

  if (SKIP_TOOLS.has(tool_name)) {
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  await ensureWorkerRunning();
  const port = getWorkerPort();

  // Check if Endless Mode is enabled
  const config = loadEndlessModeConfig();
  if (!config.enabled) {
    // Fire-and-forget mode (backward compatible)
    try {
      await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: session_id,
          tool_name,
          tool_input,
          tool_response,
          cwd: cwd || ''
        }),
        signal: AbortSignal.timeout(2000)
      });
    } catch (error: any) {
      if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') {
        throw new Error("There's a problem with the worker. Try: pm2 restart claude-mem-worker");
      }
    }
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  // ENDLESS MODE: Synchronous processing with observation injection
  try {
    // Send to worker with synchronous mode enabled
    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/observations?wait_until_obs_is_saved=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: session_id,
          tool_name,
          tool_input,
          tool_response,
          cwd: cwd || ''
        }),
        signal: AbortSignal.timeout(110000)  // 110s timeout (within 120s hook limit)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to get observation', {
        status: response.status
      }, errorText);

      // Fall back to success without injection on timeout/error
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    const data = await response.json();

    if (data.status === 'completed' && data.observation) {
      // Format observation as markdown
      const markdown = formatObservationAsMarkdown(data.observation);

      // Clear tool input from transcript to save tokens
      console.error(`[SAVE-HOOK] Checking transcript clear: toolUseId=${input.tool_use_id}, transcriptPath=${input.transcript_path}`);
      if (input.tool_use_id && input.transcript_path) {
        console.error(`[SAVE-HOOK] Clearing transcript for tool_use_id=${input.tool_use_id}`);
        const tokensSaved = await clearToolInputInTranscript(
          input.transcript_path,
          input.tool_use_id
        );
        console.error(`[SAVE-HOOK] Cleared ${tokensSaved} tokens from transcript`);
        if (tokensSaved > 0) {
          logger.debug('HOOK', 'Cleared tool input from transcript', {
            toolUseId: input.tool_use_id,
            tokensSaved
          });
        }
      } else {
        console.error(`[SAVE-HOOK] Skipping transcript clear - missing parameters`);
      }

      // Inject via additionalContext
      console.log(createHookResponse('PostToolUse', true, { context: markdown }));
    } else {
      // No observation ready, return normally
      console.log(createHookResponse('PostToolUse', true));
    }

  } catch (error: any) {
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') {
      throw new Error("There's a problem with the worker. Try: pm2 restart claude-mem-worker");
    }

    // Other errors: log but don't block
    logger.failure('HOOK', 'Error in save-hook', {}, error.message);
    console.log(createHookResponse('PostToolUse', true));
  }
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await saveHook(parsed);
});
