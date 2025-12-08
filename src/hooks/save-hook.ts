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
import { clearToolInputInTranscript, formatObservationAsMarkdown } from './context-injection.js';

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
function loadEndlessModeConfig(): { enabled: boolean; waitTimeoutMs: number } {
  try {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settingsData = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsData);
    const env = settings.env || {};

    return {
      enabled: env.CLAUDE_MEM_ENDLESS_MODE === 'true',
      waitTimeoutMs: parseInt(env.CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS || '90000', 10)
    };
  } catch (error) {
    // If settings file doesn't exist, use defaults (disabled)
    return { enabled: false, waitTimeoutMs: 90000 };
  }
}

/**
 * Wait for observations to be created and fetch them
 * Polls the worker endpoint until observations appear or timeout occurs
 */
async function waitAndFetchObservations(
  port: number,
  toolUseId: string,
  timeoutMs: number
): Promise<any[]> {
  const startTime = Date.now();
  const pollInterval = 500; // Poll every 500ms

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/sessions/observations-for-tool-use/${toolUseId}`,
        { signal: AbortSignal.timeout(2000) }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.observations && data.observations.length > 0) {
          return data.observations;
        }
      }
    } catch (error) {
      // Ignore errors and continue polling
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return []; // Timeout - return empty array
}

/**
 * Save Hook Main Logic - Fire-and-forget HTTP client
 */
async function saveHook(input?: PostToolUseInput): Promise<void> {
  if (!input) {
    throw new Error('saveHook requires input');
  }

  const { session_id, transcript_path, cwd, tool_name, tool_input, tool_response, tool_use_id } = input;

  if (SKIP_TOOLS.has(tool_name)) {
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  // Ensure worker is running
  await ensureWorkerRunning();

  const port = getWorkerPort();

  const toolStr = logger.formatTool(tool_name, tool_input);

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    workerPort: port
  });

  try {
    // Send to worker - worker handles privacy check and database operations
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claudeSessionId: session_id,
        tool_name,
        tool_input,
        tool_response,
        cwd: cwd || '',
        toolUseId: tool_use_id  // Pass tool_use_id for Endless Mode observation correlation
      }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to send observation', {
        status: response.status
      }, errorText);
      throw new Error(`Failed to send observation to worker: ${response.status} ${errorText}`);
    }

    logger.debug('HOOK', 'Observation sent successfully', { toolName: tool_name });
  } catch (error: any) {
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    throw error;
  }

  // Check if Endless Mode is enabled
  const config = loadEndlessModeConfig();
  if (!config.enabled || !tool_use_id || !transcript_path) {
    // Endless Mode disabled or missing required fields - return normally
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  // Endless Mode v7.1: Wait for observations and inject via additionalContext
  try {
    logger.debug('HOOK', 'Endless Mode: waiting for observations', {
      toolUseId: tool_use_id,
      timeoutMs: config.waitTimeoutMs
    });

    const observations = await waitAndFetchObservations(port, tool_use_id, config.waitTimeoutMs);

    if (observations.length === 0) {
      logger.debug('HOOK', 'Endless Mode: no observations found (timeout)', {
        toolUseId: tool_use_id
      });
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    logger.debug('HOOK', 'Endless Mode: observations retrieved', {
      toolUseId: tool_use_id,
      count: observations.length
    });

    // Clear tool input from transcript to save tokens
    await clearToolInputInTranscript(transcript_path, tool_use_id);

    // Format observations as markdown
    const additionalContext = observations
      .map(formatObservationAsMarkdown)
      .join('\n\n---\n\n');

    // Return with additionalContext
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext
      }
    }));
  } catch (error: any) {
    // Endless Mode error - log but don't fail the hook
    logger.failure('HOOK', 'Endless Mode error (falling back to normal)', {
      toolUseId: tool_use_id
    }, error.message);
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
