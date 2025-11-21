/**
 * Deferred Transformation - Shared utility for Endless Mode
 *
 * Replaces raw tool outputs in transcript with compressed observations
 * once observations become available. Can be called from any hook.
 */

import { readFileSync, writeFileSync, renameSync } from 'fs';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { logger } from '../utils/logger.js';
import { appendToolOutput } from './tool-output-backup.js';
import type { TranscriptEntry, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';
import type { Observation } from '../services/worker-types.js';

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
export function extractPendingToolUseIds(transcriptPath: string): string[] {
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
export function formatObservationAsMarkdown(obs: Observation): string {
  const factsArray = parseArrayField(obs.facts, 'facts');
  const conceptsArray = parseArrayField(obs.concepts, 'concepts');
  const filesRead = parseArrayField(obs.files_read, 'files_read');
  const filesModified = parseArrayField(obs.files_modified, 'files_modified');

  return `# ${obs.title}
${obs.subtitle ? `**${obs.subtitle}**\n` : ''}
${obs.narrative ? `${obs.narrative}\n` : ''}
${factsArray.length > 0 ? `**Key Facts:**\n${factsArray.map(f => `- ${f}`).join('\n')}\n` : ''}
${conceptsArray.length > 0 ? `**Concepts**: ${conceptsArray.join(', ')}\n` : ''}
${filesRead.length > 0 ? `**Files Read**: ${filesRead.join(', ')}\n` : ''}
${filesModified.length > 0 ? `**Files Modified**: ${filesModified.join(', ')}\n` : ''}
---
*[Compressed by Endless Mode]*`;
}

/**
 * Transform transcript JSONL file by replacing tool result with compressed observation
 *
 * ALWAYS creates timestamped backup before transformation for data safety
 *
 * Returns compression stats for tracking
 */
export async function transformTranscript(
  transcriptPath: string,
  toolUseId: string,
  observation: Observation
): Promise<{ originalTokens: number; compressedTokens: number }> {
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

  // Write to temp file and atomically rename
  const tempPath = `${transcriptPath}.tmp`;
  writeFileSync(tempPath, transformedLines.join('\n') + '\n', 'utf-8');
  renameSync(tempPath, transcriptPath);

  return { originalTokens: originalSize, compressedTokens: compressedSize };
}

/**
 * Run deferred transformation check
 *
 * Scans transcript for untransformed tool results and replaces them with
 * observations that have become available in the database.
 *
 * Safe to call from any hook - will only transform if observations are ready.
 *
 * @param transcriptPath Path to session transcript JSONL file
 * @param sessionId Session ID for database lookups
 * @param hookName Name of hook calling this (for logging)
 * @returns Number of transformations performed
 */
export async function runDeferredTransformation(
  transcriptPath: string,
  sessionId: string,
  hookName: string
): Promise<number> {
  let transformCount = 0;

  try {
    const pendingToolUseIds = extractPendingToolUseIds(transcriptPath);

    if (pendingToolUseIds.length === 0) {
      return 0;
    }

    logger.debug(hookName, 'Found pending tool_use_ids', {
      count: pendingToolUseIds.length,
      ids: pendingToolUseIds
    });

    // Check which observations are ready in database
    const observationsDb = new SessionStore();
    const readyObservationsMap = observationsDb.getObservationsByToolUseIds(pendingToolUseIds);
    observationsDb.close();

    if (readyObservationsMap.size === 0) {
      return 0;
    }

    logger.info(hookName, 'Ready observations for transformation', {
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

        const stats = await transformTranscript(transcriptPath, toolUseId, observation);

        // Update Endless Mode stats in database (if table exists)
        if (stats.originalTokens > 0) {
          try {
            const statsDb = new SessionStore();
            statsDb.incrementEndlessModeStats(sessionId, stats.originalTokens, stats.compressedTokens);
            statsDb.close();
          } catch (statsError) {
            // Stats table might not exist - that's ok
            logger.debug(hookName, 'Stats update skipped', { error: statsError });
          }
        }

        logger.success(hookName, 'Deferred transformation complete', {
          toolUseId,
          observationId: obsRow.id,
          savings: `${Math.round((1 - stats.compressedTokens / stats.originalTokens) * 100)}%`
        });

        transformCount++;
      } catch (transformError) {
        logger.warn(hookName, 'Deferred transformation failed', { toolUseId }, transformError as Error);
        // Continue with other transformations
      }
    }
  } catch (error) {
    logger.warn(hookName, 'Deferred transformation check failed', {}, error as Error);
    // Don't throw - this shouldn't block the hook
  }

  return transformCount;
}
