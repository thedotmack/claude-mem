/**
 * Summary Hook - Stop
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { readFileSync, existsSync, writeFileSync, renameSync, copyFileSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { logger } from '../utils/logger.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { silentDebug } from '../utils/silent-debug.js';
import { EndlessModeConfig } from '../services/worker/EndlessModeConfig.js';
import { BACKUPS_DIR, createBackupFilename, ensureDir } from '../shared/paths.js';
import { appendToolOutput, trimBackupFile } from '../shared/tool-output-backup.js';
import type { TranscriptEntry, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';
import type { Observation } from '../services/worker-types.js';

export interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  [key: string]: any;
}

/**
 * Extract tool_use_ids from transcript that haven't been transformed yet
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
 * Helper: Parse array field (handles both arrays and JSON strings)
 */
function parseArrayField(field: any, fieldName: string): string[] {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  try {
    const parsed = JSON.parse(field);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * Format an observation as markdown for Endless Mode compression
 */
function formatObservationAsMarkdown(obs: Observation): string {
  const parts: string[] = [];

  parts.push(`# ${obs.title}`);
  if (obs.subtitle) {
    parts.push(`**${obs.subtitle}**`);
  }
  parts.push('');

  if (obs.narrative) {
    parts.push(obs.narrative);
    parts.push('');
  }

  const factsArray = parseArrayField(obs.facts, 'facts');
  if (factsArray.length > 0) {
    parts.push('**Key Facts:**');
    factsArray.forEach((fact: string) => parts.push(`- ${fact}`));
    parts.push('');
  }

  const conceptsArray = parseArrayField(obs.concepts, 'concepts');
  if (conceptsArray.length > 0) {
    parts.push(`**Concepts**: ${conceptsArray.join(', ')}`);
    parts.push('');
  }

  const filesRead = parseArrayField(obs.files_read, 'files_read');
  if (filesRead.length > 0) {
    parts.push(`**Files Read**: ${filesRead.join(', ')}`);
    parts.push('');
  }

  const filesModified = parseArrayField(obs.files_modified, 'files_modified');
  if (filesModified.length > 0) {
    parts.push(`**Files Modified**: ${filesModified.join(', ')}`);
    parts.push('');
  }

  parts.push('---');
  parts.push('*[Compressed by Endless Mode]*');

  return parts.join('\n');
}

/**
 * Transform transcript by replacing tool result with compressed observation
 */
async function transformTranscript(
  transcriptPath: string,
  toolUseId: string,
  observation: Observation
): Promise<{ originalTokens: number; compressedTokens: number }> {
  // Create backup
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

  const transcriptContent = readFileSync(transcriptPath, 'utf-8');
  const lines = transcriptContent.trim().split('\n');

  let found = false;
  let originalSize = 0;
  let compressedSize = 0;

  const transformedLines = lines.map((line, i) => {
    if (!line.trim()) return line;

    try {
      const entry: TranscriptEntry = JSON.parse(line);

      if (entry.type === 'user') {
        const userEntry = entry as UserTranscriptEntry;
        const content = userEntry.message.content;

        if (Array.isArray(content)) {
          for (let j = 0; j < content.length; j++) {
            const item = content[j];
            if (item.type === 'tool_result') {
              const toolResult = item as ToolResultContent;
              if (toolResult.tool_use_id === toolUseId) {
                found = true;

                // Backup original tool output
                try {
                  appendToolOutput(toolUseId, toolResult.content, Date.now());
                } catch (backupError) {
                  logger.warn('HOOK', 'Failed to backup original tool output', { toolUseId }, backupError as Error);
                }

                originalSize = JSON.stringify(toolResult.content).length;
                const compressedContent = formatObservationAsMarkdown(observation);
                compressedSize = compressedContent.length;

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
      logger.warn('HOOK', 'Malformed JSONL line in transcript', { lineIndex: i, error: parseError });
      throw new Error(`Malformed JSONL line at index ${i}: ${parseError.message}`);
    }
  });

  if (!found) {
    logger.warn('HOOK', 'Tool result not found in transcript', { toolUseId });
    return { originalTokens: 0, compressedTokens: 0 };
  }

  const tempPath = `${transcriptPath}.tmp`;
  writeFileSync(tempPath, transformedLines.join('\n') + '\n', 'utf-8');

  // Validate JSONL
  const validatedContent = readFileSync(tempPath, 'utf-8');
  const validatedLines = validatedContent.trim().split('\n');
  for (const line of validatedLines) {
    if (line.trim()) {
      JSON.parse(line);
    }
  }

  renameSync(tempPath, transcriptPath);

  const CHARS_PER_TOKEN = 4;
  const originalTokens = Math.ceil(originalSize / CHARS_PER_TOKEN);
  const compressedTokens = Math.ceil(compressedSize / CHARS_PER_TOKEN);

  // Trim backup file
  try {
    const config = EndlessModeConfig.getConfig();
    if (config.maxToolHistoryMB > 0) {
      trimBackupFile(config.maxToolHistoryMB);
    }
  } catch (trimError) {
    logger.warn('HOOK', 'Failed to trim tool output backup', {}, trimError as Error);
  }

  return { originalTokens, compressedTokens };
}

/**
 * Extract last user message from transcript JSONL file
 */
function extractLastUserMessage(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return '';
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return '';
    }

    const lines = content.split('\n');

    // Parse JSONL and find last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);

        // Claude Code transcript format: {type: "user", message: {role: "user", content: [...]}}
        if (line.type === 'user' && line.message?.content) {
          const content = line.message.content;

          // Extract text content (handle both string and array formats)
          if (typeof content === 'string') {
            return content;
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            return textParts.join('\n');
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (error) {
    logger.error('HOOK', 'Failed to read transcript', { transcriptPath }, error as Error);
  }

  return '';
}

/**
 * Extract last assistant message from transcript JSONL file
 * Filters out system-reminder tags to avoid polluting summaries
 */
function extractLastAssistantMessage(transcriptPath: string): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return '';
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return '';
    }

    const lines = content.split('\n');

    // Parse JSONL and find last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = JSON.parse(lines[i]);

        // Claude Code transcript format: {type: "assistant", message: {role: "assistant", content: [...]}}
        if (line.type === 'assistant' && line.message?.content) {
          let text = '';
          const content = line.message.content;

          // Extract text content (handle both string and array formats)
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            text = textParts.join('\n');
          }

          // Filter out system-reminder tags and their content
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

          // Clean up excessive whitespace
          text = text.replace(/\n{3,}/g, '\n\n').trim();

          return text;
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (error) {
    logger.error('HOOK', 'Failed to read transcript', { transcriptPath }, error as Error);
  }

  return '';
}

/**
 * Summary Hook Main Logic
 */
async function summaryHook(input?: StopInput): Promise<void> {
  if (!input) {
    throw new Error('summaryHook requires input');
  }

  const { session_id, transcript_path } = input;

  // Ensure worker is running
  await ensureWorkerRunning();

  // ENDLESS MODE: Transform any remaining untransformed tool results before summarizing
  const endlessModeConfig = EndlessModeConfig.getConfig();
  if (endlessModeConfig.enabled && transcript_path && existsSync(transcript_path)) {
    try {
      const pendingToolUseIds = extractPendingToolUseIds(transcript_path);

      if (pendingToolUseIds.length > 0) {
        logger.info('HOOK', 'Stop hook: Found pending transformations', {
          count: pendingToolUseIds.length,
          ids: pendingToolUseIds
        });

        // Check which observations are ready
        const observationsDb = new SessionStore();
        const readyObservationsMap = observationsDb.getObservationsByToolUseIds(pendingToolUseIds);
        observationsDb.close();

        logger.info('HOOK', 'Stop hook: Ready observations for final transformation', {
          pending: pendingToolUseIds.length,
          ready: readyObservationsMap.size
        });

        // Transform transcript for each ready observation
        for (const [toolUseId, obsRow] of readyObservationsMap) {
          try {
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

            if (stats.originalTokens > 0) {
              const statsDb = new SessionStore();
              statsDb.incrementEndlessModeStats(session_id, stats.originalTokens, stats.compressedTokens);
              statsDb.close();
            }

            logger.success('HOOK', 'Stop hook: Final transformation complete', {
              toolUseId,
              observationId: obsRow.id,
              savings: `${Math.round((1 - stats.compressedTokens / stats.originalTokens) * 100)}%`
            });
          } catch (transformError) {
            logger.warn('HOOK', 'Stop hook: Final transformation failed', { toolUseId }, transformError as Error);
          }
        }
      } else {
        logger.debug('HOOK', 'Stop hook: No pending transformations found');
      }
    } catch (error) {
      logger.warn('HOOK', 'Stop hook: Transformation check failed', {}, error as Error);
    }
  }

  const db = new SessionStore();

  // Get or create session
  const sessionDbId = db.createSDKSession(session_id, '', '');
  const promptNumber = db.getPromptCounter(sessionDbId);

  // DIAGNOSTIC: Check session and observations
  const sessionInfo = db.db.prepare(`
    SELECT id, claude_session_id, sdk_session_id, project
    FROM sdk_sessions WHERE id = ?
  `).get(sessionDbId) as any;

  const obsCount = db.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations
    WHERE sdk_session_id = ?
  `).get(sessionInfo?.sdk_session_id) as { count: number };

  silentDebug('[summary-hook] Session diagnostics', {
    claudeSessionId: session_id,
    sessionDbId,
    sdkSessionId: sessionInfo?.sdk_session_id,
    project: sessionInfo?.project,
    promptNumber,
    observationCount: obsCount?.count || 0,
    transcriptPath: input.transcript_path
  });

  db.close();

  const port = getWorkerPort();

  // Extract last user AND assistant messages from transcript
  const lastUserMessage = extractLastUserMessage(input.transcript_path || '');
  const lastAssistantMessage = extractLastAssistantMessage(input.transcript_path || '');

  silentDebug('[summary-hook] Extracted messages', {
    hasLastUserMessage: !!lastUserMessage,
    hasLastAssistantMessage: !!lastAssistantMessage,
    lastAssistantPreview: lastAssistantMessage.substring(0, 200),
    lastAssistantLength: lastAssistantMessage.length
  });

  logger.dataIn('HOOK', 'Stop: Requesting summary', {
    sessionId: sessionDbId,
    workerPort: port,
    promptNumber,
    hasLastUserMessage: !!lastUserMessage,
    hasLastAssistantMessage: !!lastAssistantMessage
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt_number: promptNumber,
        last_user_message: lastUserMessage,
        last_assistant_message: lastAssistantMessage
      }),
      signal: AbortSignal.timeout(2000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to generate summary', {
        sessionId: sessionDbId,
        status: response.status
      }, errorText);
      throw new Error(`Failed to request summary from worker: ${response.status} ${errorText}`);
    }

    logger.debug('HOOK', 'Summary request sent successfully', { sessionId: sessionDbId });
  } catch (error: any) {
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    // Re-throw HTTP errors and other errors as-is
    throw error;
  } finally {
    await fetch(`http://127.0.0.1:${port}/api/processing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isProcessing: false })
    });
  }

  console.log(createHookResponse('Stop', true));
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await summaryHook(parsed);
});
