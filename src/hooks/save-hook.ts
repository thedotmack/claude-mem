/**
 * Save Hook - PostToolUse
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import type { TranscriptEntry, AssistantTranscriptEntry, ToolUseContent, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';
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

// Tools to skip (low value or too frequent)
const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool',  // MCP infrastructure
  'SlashCommand',          // Command invocation (observe what it produces, not the call)
  'Skill',                 // Skill invocation (observe what it produces, not the call)
  'TodoWrite',             // Task management meta-tool
  'AskUserQuestion'        // User interaction, not substantive work
]);

/**
 * Extract the most recent tool_use_id from the transcript
 * This is needed for Endless Mode to link observations to tool uses
 */
function getLatestToolUseId(transcriptPath: string, toolName: string): string | null {
  try {
    const transcriptContent = readFileSync(transcriptPath, 'utf-8');
    const lines = transcriptContent.trim().split('\n').filter(line => line.trim());

    // Search backwards through transcript for most recent tool_use matching the tool name
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: TranscriptEntry = JSON.parse(lines[i]);

        // Look for assistant messages with tool_use content
        if (entry.type === 'assistant') {
          const assistantEntry = entry as AssistantTranscriptEntry;
          const content = assistantEntry.message.content;

          // Find tool_use content matching the tool name
          for (const item of content) {
            if (item.type === 'tool_use') {
              const toolUse = item as ToolUseContent;
              if (toolUse.name === toolName) {
                return toolUse.id; // Found the most recent tool_use_id
              }
            }
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    return null; // No matching tool_use found
  } catch (error) {
    logger.warn('HOOK', 'Failed to read transcript for tool_use_id', { transcriptPath }, error);
    return null;
  }
}

/**
 * Format an observation as markdown for Endless Mode compression
 */
function formatObservationAsMarkdown(obs: Observation): string {
  const parts: string[] = [];

  // Title and subtitle
  parts.push(`# ${obs.title}`);
  if (obs.subtitle) {
    parts.push(`**${obs.subtitle}**`);
  }
  parts.push('');

  // Narrative
  if (obs.narrative) {
    parts.push(obs.narrative);
    parts.push('');
  }

  // Facts (handle both array and JSON string)
  if (obs.facts) {
    try {
      const factsArray = Array.isArray(obs.facts) ? obs.facts : JSON.parse(obs.facts);
      if (Array.isArray(factsArray) && factsArray.length > 0) {
        parts.push('**Key Facts:**');
        factsArray.forEach((fact: string) => parts.push(`- ${fact}`));
        parts.push('');
      }
    } catch (e) {
      // Skip malformed facts
    }
  }

  // Concepts (handle both array and JSON string)
  if (obs.concepts) {
    try {
      const conceptsArray = Array.isArray(obs.concepts) ? obs.concepts : JSON.parse(obs.concepts);
      if (Array.isArray(conceptsArray) && conceptsArray.length > 0) {
        parts.push(`**Concepts**: ${conceptsArray.join(', ')}`);
        parts.push('');
      }
    } catch (e) {
      // Skip malformed concepts
    }
  }

  // Files (handle both array and JSON string)
  if (obs.files_read) {
    try {
      const filesArray = Array.isArray(obs.files_read) ? obs.files_read : JSON.parse(obs.files_read);
      if (Array.isArray(filesArray) && filesArray.length > 0) {
        parts.push(`**Files Read**: ${filesArray.join(', ')}`);
        parts.push('');
      }
    } catch (e) {
      // Skip malformed files
    }
  }

  if (obs.files_modified) {
    try {
      const filesArray = Array.isArray(obs.files_modified) ? obs.files_modified : JSON.parse(obs.files_modified);
      if (Array.isArray(filesArray) && filesArray.length > 0) {
        parts.push(`**Files Modified**: ${filesArray.join(', ')}`);
        parts.push('');
      }
    } catch (e) {
      // Skip malformed files
    }
  }

  // Footer
  parts.push('---');
  parts.push('*[Compressed by Endless Mode]*');

  return parts.join('\n');
}

/**
 * Transform transcript JSONL file by replacing tool result with compressed observation
 * Phase 2 of Endless Mode implementation
 */
async function transformTranscript(
  transcriptPath: string,
  toolUseId: string,
  observation: Observation
): Promise<void> {
  // Create backup
  const backupPath = `${transcriptPath}.backup`;
  copyFileSync(transcriptPath, backupPath);

  try {
    // Read transcript
    const transcriptContent = readFileSync(transcriptPath, 'utf-8');
    const lines = transcriptContent.trim().split('\n');

    // Track transformation
    let found = false;
    let originalSize = 0;
    let compressedSize = 0;

    // Process each line
    const transformedLines = lines.map(line => {
      if (!line.trim()) return line;

      try {
        const entry: TranscriptEntry = JSON.parse(line);

        // Look for user messages with tool_result content
        if (entry.type === 'user') {
          const userEntry = entry as UserTranscriptEntry;
          const content = userEntry.message.content;

          // Check if content is an array
          if (Array.isArray(content)) {
            // Find and replace matching tool_result
            for (let i = 0; i < content.length; i++) {
              const item = content[i];
              if (item.type === 'tool_result') {
                const toolResult = item as ToolResultContent;
                if (toolResult.tool_use_id === toolUseId) {
                  found = true;

                  // Measure original size
                  originalSize = JSON.stringify(toolResult.content).length;

                  // Format compressed observation
                  const compressedContent = formatObservationAsMarkdown(observation);
                  compressedSize = compressedContent.length;

                  // Replace content
                  toolResult.content = compressedContent;

                  logger.success('HOOK', 'Transformed tool result', {
                    toolUseId,
                    originalSize,
                    compressedSize,
                    savings: `${Math.round((1 - compressedSize / originalSize) * 100)}%`
                  });
                }
              }
            }
          }
        }

        return JSON.stringify(entry);
      } catch (parseError) {
        // Return malformed lines as-is
        return line;
      }
    });

    if (!found) {
      logger.warn('HOOK', 'Tool result not found in transcript', { toolUseId });
      // Clean up backup and return without modifying
      unlinkSync(backupPath);
      return;
    }

    // Write to temp file
    const tempPath = `${transcriptPath}.tmp`;
    writeFileSync(tempPath, transformedLines.join('\n') + '\n', 'utf-8');

    // Validate JSONL structure
    const validatedContent = readFileSync(tempPath, 'utf-8');
    const validatedLines = validatedContent.trim().split('\n');
    for (const line of validatedLines) {
      if (line.trim()) {
        JSON.parse(line); // Will throw if invalid
      }
    }

    // Atomic rename
    renameSync(tempPath, transcriptPath);

    // Clean up backup
    unlinkSync(backupPath);

    logger.success('HOOK', 'Transcript transformation complete', {
      toolUseId,
      originalSize,
      compressedSize,
      savings: `${Math.round((1 - compressedSize / originalSize) * 100)}%`
    });
  } catch (error) {
    // Rollback on error
    logger.failure('HOOK', 'Transcript transformation failed, rolling back', { toolUseId }, error);
    copyFileSync(backupPath, transcriptPath);
    unlinkSync(backupPath);
    throw error;
  }
}

/**
 * Save Hook Main Logic
 */
async function saveHook(input?: PostToolUseInput): Promise<void> {
  if (!input) {
    throw new Error('saveHook requires input');
  }

  const { session_id, cwd, tool_name, tool_input, tool_response, transcript_path } = input;

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

  // Extract tool_use_id from transcript for Endless Mode
  const toolUseId = getLatestToolUseId(transcript_path, tool_name);

  const toolStr = logger.formatTool(tool_name, tool_input);

  const port = getWorkerPort();

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    sessionId: sessionDbId,
    workerPort: port,
    toolUseId: toolUseId || '(none)'
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        tool_input: tool_input !== undefined ? JSON.stringify(tool_input) : '{}',
        tool_response: tool_response !== undefined ? JSON.stringify(tool_response) : '{}',
        prompt_number: promptNumber,
        cwd: cwd || '',
        tool_use_id: toolUseId
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
