/**
 * Save Hook - PostToolUse
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { EndlessModeConfig } from '../services/worker/EndlessModeConfig.js';
import { silentDebug } from '../utils/silent-debug.js';
import { BACKUPS_DIR, createBackupFilename, ensureDir } from '../shared/paths.js';
import { appendToolOutput, trimBackupFile } from '../shared/tool-output-backup.js';
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

interface ObservationEndpointResponse {
  status: 'queued' | 'completed' | 'timeout';
  observation?: Observation | null;
  processing_time_ms?: number;
  message?: string;
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
 * Helper: Parse array field (handles both arrays and JSON strings)
 */
function parseArrayField(field: any, fieldName: string): string[] {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  try {
    const parsed = JSON.parse(field);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logger.debug('HOOK', `Failed to parse ${fieldName}`, { field, error: e });
    return [];
  }
}

/**
 * Extract tool_use_ids from transcript that haven't been transformed yet
 * A tool result is "untransformed" if its content is still structured (object/string)
 * vs transformed (markdown starting with "# ")
 */
function extractPendingToolUseIds(transcriptPath: string): string[] {
  try {
    const transcriptContent = readFileSync(transcriptPath, 'utf-8');
    const lines = transcriptContent.trim().split('\n');
    const pendingIds: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry: TranscriptEntry = JSON.parse(line);

        // Look for user messages with tool_result content
        if (entry.type === 'user') {
          const userEntry = entry as UserTranscriptEntry;
          const content = userEntry.message.content;

          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === 'tool_result') {
                const toolResult = item as ToolResultContent;
                const contentStr = typeof toolResult.content === 'string'
                  ? toolResult.content
                  : JSON.stringify(toolResult.content);

                // Check if content is already transformed (starts with "# ")
                const isTransformed = contentStr.trim().startsWith('# ');

                if (!isTransformed && toolResult.tool_use_id) {
                  pendingIds.push(toolResult.tool_use_id);
                }
              }
            }
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    return pendingIds;
  } catch (error) {
    logger.warn('HOOK', 'Failed to extract pending tool_use_ids', { transcriptPath }, error as Error);
    return [];
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

  // Facts
  const factsArray = parseArrayField(obs.facts, 'facts');
  if (factsArray.length > 0) {
    parts.push('**Key Facts:**');
    factsArray.forEach((fact: string) => parts.push(`- ${fact}`));
    parts.push('');
  }

  // Concepts
  const conceptsArray = parseArrayField(obs.concepts, 'concepts');
  if (conceptsArray.length > 0) {
    parts.push(`**Concepts**: ${conceptsArray.join(', ')}`);
    parts.push('');
  }

  // Files read
  const filesRead = parseArrayField(obs.files_read, 'files_read');
  if (filesRead.length > 0) {
    parts.push(`**Files Read**: ${filesRead.join(', ')}`);
    parts.push('');
  }

  // Files modified
  const filesModified = parseArrayField(obs.files_modified, 'files_modified');
  if (filesModified.length > 0) {
    parts.push(`**Files Modified**: ${filesModified.join(', ')}`);
    parts.push('');
  }

  // Footer
  parts.push('---');
  parts.push('*[Compressed by Endless Mode]*');

  return parts.join('\n');
}

/**
 * Transform transcript JSONL file by replacing tool result with compressed observation
 * Phase 2 of Endless Mode implementation
 *
 * ALWAYS creates timestamped backup before transformation for data safety
 *
 * Returns compression stats for tracking
 */
async function transformTranscript(
  transcriptPath: string,
  toolUseId: string,
  observation: Observation
): Promise<{ originalTokens: number; compressedTokens: number }> {
  // ALWAYS create backup before transformation
  try {
    ensureDir(BACKUPS_DIR);
    const backupPath = createBackupFilename(transcriptPath);
    copyFileSync(transcriptPath, backupPath);
    logger.info('HOOK', 'Created transcript backup', {
      original: transcriptPath,
      backup: backupPath
    });
  } catch (error) {
    logger.error('HOOK', 'Failed to create transcript backup', { transcriptPath }, error as Error);
    throw new Error('Backup creation failed - aborting transformation for safety');
  }

  // Read transcript
  const transcriptContent = readFileSync(transcriptPath, 'utf-8');
  const lines = transcriptContent.trim().split('\n');

  // Track transformation
  let found = false;
  let originalSize = 0;
  let compressedSize = 0;

  // Process each line
  const transformedLines = lines.map((line, i) => {
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
          for (let j = 0; j < content.length; j++) {
            const item = content[j];
            if (item.type === 'tool_result') {
              const toolResult = item as ToolResultContent;
              if (toolResult.tool_use_id === toolUseId) {
                found = true;

                // Backup original tool output BEFORE compression (for restoration if user disables Endless Mode)
                try {
                  appendToolOutput(toolUseId, toolResult.content, Date.now());
                  logger.debug('HOOK', 'Backed up original tool output', { toolUseId });
                } catch (backupError) {
                  logger.warn('HOOK', 'Failed to backup original tool output', { toolUseId }, backupError as Error);
                  // Continue anyway - backup failure shouldn't block compression
                }

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
    } catch (parseError: any) {
      logger.warn('HOOK', 'Malformed JSONL line in transcript', {
        lineIndex: i,
        error: parseError
      });
      throw new Error(`Malformed JSONL line at index ${i}: ${parseError.message}`);
    }
  });

  if (!found) {
    logger.warn('HOOK', 'Tool result not found in transcript', { toolUseId });
    return { originalTokens: 0, compressedTokens: 0 };
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

  // Atomic rename (original untouched until this succeeds)
  renameSync(tempPath, transcriptPath);

  // Convert character counts to approximate token counts (1 token ≈ 4 chars)
  const CHARS_PER_TOKEN = 4;
  const originalTokens = Math.ceil(originalSize / CHARS_PER_TOKEN);
  const compressedTokens = Math.ceil(compressedSize / CHARS_PER_TOKEN);

  logger.success('HOOK', 'Transcript transformation complete', {
    toolUseId,
    originalSize,
    compressedSize,
    savings: `${Math.round((1 - compressedSize / originalSize) * 100)}%`
  });

  // Trim backup file to stay under size limit
  try {
    const config = EndlessModeConfig.getConfig();
    if (config.maxToolHistoryMB > 0) {
      trimBackupFile(config.maxToolHistoryMB);
      logger.debug('HOOK', 'Trimmed tool output backup', { maxSizeMB: config.maxToolHistoryMB });
    }
  } catch (trimError) {
    logger.warn('HOOK', 'Failed to trim tool output backup', {}, trimError as Error);
    // Continue anyway - trim failure shouldn't block hook
  }

  return { originalTokens, compressedTokens };
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

  // DEFERRED TRANSFORMATION: Check for ready observations from previous tools (FAST - can block)
  if (isEndlessModeEnabled && transcript_path) {
    try {
      const pendingToolUseIds = extractPendingToolUseIds(transcript_path);

      if (pendingToolUseIds.length > 0) {
        logger.debug('HOOK', 'Found pending tool_use_ids', {
          count: pendingToolUseIds.length,
          ids: pendingToolUseIds
        });

        // Check which observations are ready in database
        const observationsDb = new SessionStore();
        const readyObservationsMap = observationsDb.getObservationsByToolUseIds(pendingToolUseIds);
        observationsDb.close();

        logger.info('HOOK', 'Ready observations for transformation', {
          pending: pendingToolUseIds.length,
          ready: readyObservationsMap.size
        });

        // Transform transcript for each ready observation
        for (const [toolUseId, obsRow] of readyObservationsMap) {
          try {
            // Convert ObservationRow to Observation format for transformation
            const observation: Observation = {
              id: obsRow.id,
              type: obsRow.type as any,
              title: obsRow.title,
              subtitle: obsRow.subtitle,
              narrative: obsRow.narrative,
              facts: JSON.parse(obsRow.facts),
              concepts: JSON.parse(obsRow.concepts),
              files_read: JSON.parse(obsRow.files_read),
              files_modified: JSON.parse(obsRow.files_modified),
              created_at_epoch: obsRow.created_at_epoch
            };

            const stats = await transformTranscript(transcript_path, toolUseId, observation);

            // Update Endless Mode stats in database
            if (stats.originalTokens > 0) {
              const statsDb = new SessionStore();
              statsDb.incrementEndlessModeStats(session_id, stats.originalTokens, stats.compressedTokens);
              statsDb.close();
            }

            logger.success('HOOK', 'Deferred transformation complete', {
              toolUseId,
              observationId: obsRow.id,
              savings: `${Math.round((1 - stats.compressedTokens / stats.originalTokens) * 100)}%`
            });
          } catch (transformError) {
            logger.warn('HOOK', 'Deferred transformation failed', { toolUseId }, transformError as Error);
            // Continue with other transformations
          }
        }
      }
    } catch (error) {
      logger.warn('HOOK', 'Deferred transformation check failed', {}, error as Error);
      // Continue anyway - don't block hook
    }
  }

  try {
    // Build endpoint URL - NO MORE WAITING in Endless Mode
    const endpoint = `http://127.0.0.1:${port}/sessions/${sessionDbId}/observations`;

    // Use short timeout for all modes (async processing)
    const timeoutMs = 2000;

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
      // Continue anyway - observation failed but don't block the hook
      console.log(createHookResponse('PostToolUse', true));
      return;
    }

    // Observation queued successfully - will be processed asynchronously
    logger.debug('HOOK', 'Observation queued (async mode)', {
      sessionId: sessionDbId,
      toolName: tool_name,
      toolUseId: extractedToolUseId,
      endlessMode: isEndlessModeEnabled
    });
  } catch (error: any) {
    // Worker connection errors - suggest restart
    if (error.cause?.code === 'ECONNREFUSED') {
      logger.failure('HOOK', 'Worker connection refused', { sessionId: sessionDbId }, error);
      console.log(createHookResponse('PostToolUse', true, "Worker connection failed. Try: pm2 restart claude-mem-worker"));
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
