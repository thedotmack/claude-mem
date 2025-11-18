/**
 * PreToolUse Hook - Endless Mode Transcript Transformation
 *
 * Transforms the PREVIOUS tool's result in the transcript.
 * By running before the current tool, we guarantee the previous tool_result
 * is already written to the transcript file.
 */

import { stdin } from 'process';
import { readFileSync, writeFileSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { EndlessModeConfig } from '../services/worker/EndlessModeConfig.js';
import { silentDebug } from '../utils/silent-debug.js';
import type { TranscriptEntry, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';
import type { Observation } from '../services/worker-types.js';

export interface PreToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: any;
  transcript_path: string;
  [key: string]: any;
}

interface ObservationEndpointResponse {
  status: 'queued' | 'completed' | 'timeout';
  observation?: Observation | null;
  processing_time_ms?: number;
  message?: string;
}

// Tools to skip (low value or too frequent)
const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool',
  'SlashCommand',
  'Skill',
  'TodoWrite',
  'AskUserQuestion'
]);

/**
 * Find the most recent tool_result in transcript that hasn't been transformed yet
 */
function findPreviousToolResult(transcriptPath: string): {
  toolUseId: string;
  toolName: string;
  lineIndex: number;
  entry: UserTranscriptEntry;
  contentIndex: number;
} | null {
  try {
    const transcriptContent = readFileSync(transcriptPath, 'utf-8');
    const lines = transcriptContent.trim().split('\n');

    // Search backwards for most recent tool_result
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as TranscriptEntry;

      if (entry.type === 'user' && Array.isArray(entry.message.content)) {
        for (let contentIndex = 0; contentIndex < entry.message.content.length; contentIndex++) {
          const item = entry.message.content[contentIndex];

          if (item.type === 'tool_result') {
            const toolResult = item as ToolResultContent;

            // Skip if already transformed (contains observation reference)
            if (typeof toolResult.content === 'string' && toolResult.content.includes('[Observation #')) {
              continue;
            }

            // Found untransformed tool_result
            return {
              toolUseId: toolResult.tool_use_id,
              toolName: 'unknown', // We'll get this from the worker
              lineIndex: i,
              entry: entry as UserTranscriptEntry,
              contentIndex
            };
          }
        }
      }
    }
  } catch (error) {
    silentDebug('Failed to find previous tool_result', { error });
  }

  return null;
}

/**
 * Transform tool_result in transcript to observation reference
 */
function transformToolResult(
  transcriptPath: string,
  lineIndex: number,
  contentIndex: number,
  observation: Observation
): void {
  try {
    const transcriptContent = readFileSync(transcriptPath, 'utf-8');
    const lines = transcriptContent.split('\n');

    const entry = JSON.parse(lines[lineIndex]) as UserTranscriptEntry;
    const toolResult = entry.message.content[contentIndex] as ToolResultContent;

    // Replace content with observation reference
    const transformedContent = `[Observation #${observation.id}: ${observation.title}]`;
    toolResult.content = transformedContent;

    // Write back to transcript
    lines[lineIndex] = JSON.stringify(entry);
    writeFileSync(transcriptPath, lines.join('\n'), 'utf-8');

    silentDebug('Transformed tool_result in transcript', {
      observationId: observation.id,
      toolUseId: toolResult.tool_use_id,
      originalLength: String(toolResult.content).length,
      transformedLength: transformedContent.length
    });
  } catch (error) {
    silentDebug('Failed to transform tool_result', { error });
  }
}

async function main() {
  const inputBuffer: Buffer[] = [];

  stdin.on('data', (chunk) => {
    inputBuffer.push(Buffer.from(chunk));
  });

  stdin.on('end', async () => {
    try {
      const input = JSON.parse(Buffer.concat(inputBuffer).toString('utf-8')) as PreToolUseInput;
      const { session_id, cwd, transcript_path } = input;

      // Check if endless mode is enabled
      const endlessModeConfig = EndlessModeConfig.load();
      if (!endlessModeConfig.enabled || !transcript_path) {
        // Not enabled or no transcript - just return success
        console.log(JSON.stringify(createHookResponse({})));
        process.exit(0);
      }

      // Find the previous tool result
      const previousTool = findPreviousToolResult(transcript_path);
      if (!previousTool) {
        // No previous tool (first tool in session) or all already transformed - skip
        console.log(JSON.stringify(createHookResponse({})));
        process.exit(0);
      }

      // Ensure worker is running
      await ensureWorkerRunning();
      const workerPort = getWorkerPort();

      // Get or create session
      const store = new SessionStore();
      let sessionRecord = store.getSessionByClaudeId(session_id);
      if (!sessionRecord) {
        sessionRecord = store.createSession(session_id, cwd, 1);
      }

      // Send synchronous request to worker to save & compress observation
      const url = `http://localhost:${workerPort}/sessions/${sessionRecord.id}/observations/transform?tool_use_id=${previousTool.toolUseId}`;

      const startTime = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        silentDebug('Worker transform request failed', {
          status: response.status,
          statusText: response.statusText
        });
        console.log(JSON.stringify(createHookResponse({})));
        process.exit(0);
      }

      const result = await response.json() as ObservationEndpointResponse;
      const duration = Date.now() - startTime;

      silentDebug('Transform request completed', {
        status: result.status,
        duration,
        observationId: result.observation?.id,
        toolUseId: previousTool.toolUseId
      });

      // If observation was saved, transform the transcript
      if (result.status === 'completed' && result.observation) {
        transformToolResult(
          transcript_path,
          previousTool.lineIndex,
          previousTool.contentIndex,
          result.observation
        );
      }

      console.log(JSON.stringify(createHookResponse({})));
      process.exit(0);

    } catch (error) {
      silentDebug('PreToolUse hook error', { error });
      console.log(JSON.stringify(createHookResponse({})));
      process.exit(0);
    }
  });
}

main();
