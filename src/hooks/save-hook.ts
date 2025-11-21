/**
 * Save Hook - PostToolUse
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { readFileSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { EndlessModeConfig } from '../services/worker/EndlessModeConfig.js';
import { silentDebug } from '../utils/silent-debug.js';
import { SKIP_TOOLS } from '../shared/skip-tools.js';
import { transformTranscript } from '../shared/transcript-transformation.js';
import type { TranscriptEntry, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';
import type { Observation } from '../services/worker-types.js';

export interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  tool_response: any;
  transcript_path: string;
  [key: string]: any;
}

interface ObservationEndpointResponse {
  status: 'queued' | 'completed' | 'timeout';
  observation?: Observation | null;
  processing_time_ms?: number;
  message?: string;
}

/**
 * Save Hook Main Logic
 */
async function saveHook(input?: PostToolUseInput): Promise<void> {
  if (!input) {
    logger.warn('HOOK', 'PostToolUse called with no input');
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

  const { session_id, cwd, tool_name, tool_input, tool_response, transcript_path, tool_use_id } = input;

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
  db.close();

  const toolStr = logger.formatTool(tool_name, tool_input);
  const port = getWorkerPort();

  // Phase 3: Extract tool_use_id from transcript if available
  let extractedToolUseId: string | undefined = tool_use_id;
  if (!extractedToolUseId && transcript_path) {
    try {
      const transcriptContent = readFileSync(transcript_path, 'utf-8');
      const lines = transcriptContent.trim().split('\n');

      // Search backwards for the most recent tool_result
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]) as TranscriptEntry;
        if (entry.type === 'user' && Array.isArray(entry.message.content)) {
          for (const item of entry.message.content) {
            if (item.type === 'tool_result' && (item as ToolResultContent).tool_use_id) {
              extractedToolUseId = (item as ToolResultContent).tool_use_id;
              break;
            }
          }
          if (extractedToolUseId) break;
        }
      }
    } catch (error) {
      silentDebug('Failed to extract tool_use_id from transcript', { error });
    }
  }

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    sessionId: sessionDbId,
    workerPort: port,
    toolUseId: extractedToolUseId || silentDebug('tool_use_id not found in transcript', { toolName: tool_name }, '(none)')
  });

  // Phase 3: Check if Endless Mode is enabled
  const endlessModeConfig = EndlessModeConfig.getConfig();
  const isEndlessModeEnabled = endlessModeConfig.enabled && extractedToolUseId && transcript_path;

  // Debug logging for endless mode conditions AND all input fields
  silentDebug('Endless Mode Check', {
    configEnabled: endlessModeConfig.enabled,
    hasToolUseId: !!extractedToolUseId,
    hasTranscriptPath: !!transcript_path,
    isEndlessModeEnabled,
    toolName: tool_name,
    toolUseId: extractedToolUseId,
    allInputKeys: Object.keys(input).join(', ')
  });

  try {
    // Build endpoint URL with synchronous blocking when Endless Mode is enabled
    let endpoint = `http://127.0.0.1:${port}/sessions/${sessionDbId}/observations`;

    // In Endless Mode, wait synchronously for observation to complete and transform transcript
    if (isEndlessModeEnabled) {
      endpoint += '?wait_until_obs_is_saved=true';
    }

    // Use 90s timeout for blocking mode, 2s for regular async mode (backward compatible)
    const timeoutMs = isEndlessModeEnabled ? 90000 : 2000;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        tool_input: tool_input !== undefined ? JSON.stringify(tool_input) : '{}',
        tool_response: tool_response !== undefined ? JSON.stringify(tool_response) : '{}',
        prompt_number: promptNumber,
        cwd: cwd || '',
        tool_use_id: extractedToolUseId
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to send observation', {
        sessionId: sessionDbId,
        status: response.status
      }, errorText);
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    // Parse response
    const result = await response.json() as ObservationEndpointResponse;

    if (isEndlessModeEnabled) {
      // Synchronous mode - observation completed (or timed out)
      if (result.status === 'completed' && result.observation && extractedToolUseId) {
        // Transform transcript by replacing tool output with compressed observation
        try {
          const stats = await transformTranscript(transcript_path, extractedToolUseId, result.observation);

          // Update Endless Mode stats in database
          if (stats.originalTokens > 0) {
            const statsDb = new SessionStore();
            statsDb.incrementEndlessModeStats(session_id, stats.originalTokens, stats.compressedTokens);
            statsDb.close();
          }

          logger.success('HOOK', 'Observation completed and transcript transformed', {
            sessionId: sessionDbId,
            toolName: tool_name,
            processingTime: result.processing_time_ms,
            observationId: result.observation.id,
            tokensSaved: stats.originalTokens - stats.compressedTokens
          });
        } catch (transformError: any) {
          logger.failure('HOOK', 'Transcript transformation failed', {
            sessionId: sessionDbId,
            toolUseId: extractedToolUseId
          }, transformError);
          // Continue anyway - observation is saved, just not compressed in transcript
        }
      } else if (result.status === 'timeout') {
        logger.warn('HOOK', 'Observation timed out - continuing with uncompressed transcript', {
          sessionId: sessionDbId,
          toolName: tool_name
        });
      }
    } else {
      // Async mode - observation queued
      logger.debug('HOOK', 'Observation queued (async mode)', {
        sessionId: sessionDbId,
        toolName: tool_name
      });
    }
  } catch (error: any) {
    // Worker connection errors - suggest restart
    if (error.cause?.code === 'ECONNREFUSED') {
      logger.failure('HOOK', 'Worker connection refused', { sessionId: sessionDbId }, error);
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    // Timeout errors - just continue (observation will complete in background)
    if (error.name === 'TimeoutError' || error.message?.includes('timed out')) {
      logger.warn('HOOK', 'Observation request timed out - continuing', {
        sessionId: sessionDbId,
        toolName: tool_name
      });
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    // All other errors - log and continue (never block the hook)
    logger.warn('HOOK', 'Observation request failed - continuing anyway', {
      sessionId: sessionDbId,
      toolName: tool_name,
      error: error.message
    });
    console.log(createHookResponse('PostToolUse', true));
    return;
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
