/**
 * New Context Injection Strategy for Endless Mode
 * 
 * Instead of replacing tool results with observations in the transcript,
 * this approach:
 * 1. Clears tool inputs and replaces with "removed to save X tokens"
 * 2. Waits for observations to be generated
 * 3. Injects a programmatic tool_use that fetches observations
 * 4. Natural sequential injection maintains itself
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs';
import type { TranscriptEntry, AssistantTranscriptEntry, ToolUseContent, UserTranscriptEntry, ToolResultContent, BaseTranscriptEntry } from '../types/transcript.js';
import type { Observation } from '../services/worker-types.js';
import { logger } from '../utils/logger.js';
import { BACKUPS_DIR, createBackupFilename, ensureDir } from '../shared/paths.js';
import { randomUUID } from 'crypto';

/**
 * Clear tool input from transcript and replace with placeholder
 * This saves tokens by removing large tool inputs
 * 
 * Note: Backups are created using the existing backup system which includes
 * automatic cleanup (trimBackupFile) to prevent disk space issues
 */
export async function clearToolInputInTranscript(
  transcriptPath: string,
  toolUseId: string
): Promise<number> {
  // Create backup (managed by existing backup system with size limits)
  try {
    ensureDir(BACKUPS_DIR);
    const backupPath = createBackupFilename(transcriptPath);
    copyFileSync(transcriptPath, backupPath);
    logger.debug('HOOK', 'Created transcript backup before clearing input', {
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
  
  let tokensSaved = 0;
  const transformedLines: string[] = [];
  
  for (const line of lines) {
    if (!line.trim()) {
      transformedLines.push(line);
      continue;
    }
    
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      
      // Find assistant message with matching tool_use
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        const assistantEntry = entry as AssistantTranscriptEntry;
        let modified = false;
        
        for (const item of assistantEntry.message.content) {
          if (item.type === 'tool_use') {
            const toolUse = item as ToolUseContent;
            
            if (toolUse.id === toolUseId) {
              // Calculate tokens saved
              // Note: Using simplified estimate of 4 chars per token
              // This is intentionally approximate for simplicity - actual tokenization
              // varies by content type and tokenizer. Good enough for user display.
              const originalSize = JSON.stringify(toolUse.input).length;
              tokensSaved = Math.ceil(originalSize / 4);
              
              // Replace input with placeholder
              toolUse.input = {
                _cleared: true,
                message: `[Input removed to save ~${tokensSaved} tokens - observation will be injected]`
              };
              
              modified = true;
              logger.info('HOOK', 'Cleared tool input', {
                toolUseId,
                tokensSaved,
                originalSize
              });
              break;
            }
          }
        }
        
        if (modified) {
          transformedLines.push(JSON.stringify(entry));
        } else {
          transformedLines.push(line);
        }
      } else {
        transformedLines.push(line);
      }
    } catch (parseError) {
      logger.warn('HOOK', 'Malformed JSONL line in transcript', { line });
      transformedLines.push(line);
    }
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
  
  return tokensSaved;
}

/**
 * Inject a programmatic tool_use and tool_result that fetches observations
 * This makes observations appear naturally in the transcript as tool results
 */
export async function injectObservationFetchInTranscript(
  transcriptPath: string,
  sessionId: string,
  cwd: string,
  observations: Observation[]
): Promise<void> {
  if (observations.length === 0) {
    logger.debug('HOOK', 'No observations to inject');
    return;
  }
  
  // Read current transcript to get context for new entries
  const transcriptContent = readFileSync(transcriptPath, 'utf-8');
  const lines = transcriptContent.trim().split('\n');
  
  // Get the last entry to extract metadata
  const lastEntry = JSON.parse(lines[lines.length - 1]) as TranscriptEntry;
  
  // Create base metadata from last entry
  const baseMetadata: Partial<BaseTranscriptEntry> = {
    isSidechain: false,
    userType: (lastEntry as any).userType || 'user',
    cwd: cwd,
    sessionId: sessionId,
    version: (lastEntry as any).version || '1.0',
    timestamp: new Date().toISOString()
  };
  
  // Generate unique tool_use_id using UUID (truncated for readability while maintaining uniqueness)
  // Note: 20 chars from UUID provides 16^20 = ~1.2e24 possible IDs, collision risk is negligible
  const toolUseId = `toolu_mem_${randomUUID().replace(/-/g, '').substring(0, 20)}`;
  
  // Create assistant message with tool_use for fetching observations
  const assistantEntry: AssistantTranscriptEntry = {
    ...baseMetadata as BaseTranscriptEntry,
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'claude-mem-fetch-observations',
        input: {
          observation_ids: observations.map(o => o.id),
          note: 'Fetching compressed observations for context'
        }
      }],
      stop_reason: 'tool_use'
    }
  };
  
  // Format observations as markdown
  const observationMarkdown = observations
    .map(obs => formatObservationAsMarkdown(obs))
    .join('\n\n---\n\n');
  
  // Create user message with tool_result containing observations
  const userEntry: UserTranscriptEntry = {
    ...baseMetadata as BaseTranscriptEntry,
    type: 'user',
    uuid: randomUUID(),
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: observationMarkdown
      }]
    }
  };
  
  // Append to transcript
  const newLines = [
    JSON.stringify(assistantEntry),
    JSON.stringify(userEntry)
  ];
  
  writeFileSync(transcriptPath, transcriptContent + '\n' + newLines.join('\n') + '\n', 'utf-8');
  
  logger.success('HOOK', 'Injected observation fetch in transcript', {
    toolUseId,
    observationCount: observations.length,
    transcriptPath
  });
}

/**
 * Format observation as markdown (simplified version)
 */
function formatObservationAsMarkdown(obs: Observation): string {
  const parts: string[] = [];
  
  // Title
  parts.push(`## ${obs.title}`);
  
  // Subtitle
  if (obs.subtitle) {
    parts.push(obs.subtitle);
  }
  
  // Narrative
  if (obs.narrative) {
    parts.push(obs.narrative);
  }
  
  // Facts
  const factsArray = parseArrayField(obs.facts);
  if (factsArray.length > 0) {
    parts.push(`Facts: ${factsArray.join('; ')}`);
  }
  
  // Concepts
  const conceptsArray = parseArrayField(obs.concepts);
  if (conceptsArray.length > 0) {
    parts.push(`Concepts: ${conceptsArray.join(', ')}`);
  }
  
  return parts.join('\n\n');
}

/**
 * Helper: Parse array field
 */
function parseArrayField(field: any): string[] {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  try {
    const parsed = JSON.parse(field);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
