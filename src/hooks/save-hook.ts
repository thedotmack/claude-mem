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
import { EventSource } from 'eventsource';
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
 * Endless Mode configuration (loaded once at startup)
 */
const ENDLESS_MODE_CONFIG = loadEndlessModeConfig();

/**
 * Subscribe to SSE processing status and wait for queue to empty
 * Returns when "Queue depth: 1" broadcast is received
 */
async function waitForProcessingComplete(
  port: number,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      eventSource?.close();
      resolve(false); // Timeout
    }, timeoutMs);

    let eventSource: EventSource | null = null;

    try {
      // Connect to SSE endpoint
      eventSource = new EventSource(`http://127.0.0.1:${port}/stream`);

      eventSource.addEventListener('processing_status', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);

          // Check if queue is empty (all observations processed)
          if (data.queueDepth === 1) {
            clearTimeout(timeoutId);
            eventSource?.close();
            resolve(true); // Success
          }
        } catch (error) {
          // Invalid JSON, ignore
        }
      });

      eventSource.onerror = () => {
        clearTimeout(timeoutId);
        eventSource?.close();
        resolve(false); // Connection error
      };
    } catch (error) {
      clearTimeout(timeoutId);
      resolve(false);
    }
  });
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

  // If missing required fields for observation correlation, return normally
  if (!tool_use_id || !transcript_path) {
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  // ALWAYS wait for observations to be processed (no conditional flag)
  try {
    logger.debug('HOOK', 'Waiting for observations to be processed', {
      toolUseId: tool_use_id,
      timeoutMs: ENDLESS_MODE_CONFIG.waitTimeoutMs
    });

    // Wait for worker queue to empty (SSE subscription)
    const completed = await waitForProcessingComplete(port, ENDLESS_MODE_CONFIG.waitTimeoutMs);

    if (!completed) {
      logger.debug('HOOK', 'Timeout waiting for observations', {
        toolUseId: tool_use_id
      });
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    // Fetch observations created for this tool_use_id
    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/observations-for-tool-use/${tool_use_id}`,
      { signal: AbortSignal.timeout(2000) }
    );

    if (!response.ok) {
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    const data = await response.json();
    const observations = data.observations || [];

    if (observations.length === 0) {
      logger.debug('HOOK', 'No observations found for tool_use_id', {
        toolUseId: tool_use_id
      });
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    // Only inject if Endless Mode is enabled
    if (!ENDLESS_MODE_CONFIG.enabled) {
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
    // Error - log but don't fail the hook
    logger.failure('HOOK', 'Error waiting for observations (falling back to normal)', {
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
