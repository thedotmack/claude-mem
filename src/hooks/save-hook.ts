/**
 * Save Hook - PostToolUse
 * Consolidated entry point + logic
 */

import { stdin } from 'process';
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, createReadStream } from 'fs';
import { dirname, join, basename } from 'path';
import { createInterface } from 'readline';
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
 * Format observation as plain text (no markdown - AI doesn't need it)
 * Concatenates only the essential content for maximum compression
 */
export function formatObservationAsMarkdown(obs: Observation): string {
  const parts: string[] = [];

  // Title and subtitle (plain text, no markdown)
  parts.push(obs.title);
  if (obs.subtitle) {
    parts.push(obs.subtitle);
  }

  // Narrative
  if (obs.narrative) {
    parts.push(obs.narrative);
  }

  // Facts (plain list, no bullets)
  const factsArray = parseArrayField(obs.facts, 'facts');
  if (factsArray.length > 0) {
    parts.push(`Facts: ${factsArray.join('; ')}`);
  }

  // Concepts
  const conceptsArray = parseArrayField(obs.concepts, 'concepts');
  if (conceptsArray.length > 0) {
    parts.push(`Concepts: ${conceptsArray.join(', ')}`);
  }

  // Files read
  const filesRead = parseArrayField(obs.files_read, 'files_read');
  if (filesRead.length > 0) {
    parts.push(`Files read: ${filesRead.join(', ')}`);
  }

  // Files modified
  const filesModified = parseArrayField(obs.files_modified, 'files_modified');
  if (filesModified.length > 0) {
    parts.push(`Files modified: ${filesModified.join(', ')}`);
  }

  // Simple separator between parts (just space, not markdown)
  return parts.join('. ');
}

/**
 * Auto-discover agent transcript files linked to main session
 * Parses main transcript for toolUseResult.agentId references
 */
async function discoverAgentFiles(mainTranscriptPath: string): Promise<string[]> {
  const agentIds = new Set<string>();

  try {
    const fileStream = createReadStream(mainTranscriptPath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.includes('agentId')) continue;

      try {
        const obj = JSON.parse(line);

        // Check for agentId in toolUseResult
        if (obj.toolUseResult?.agentId) {
          agentIds.add(obj.toolUseResult.agentId);
        }
      } catch (e) {
        // Skip malformed lines
      }
    }

    // Build agent file paths
    const directory = dirname(mainTranscriptPath);
    const agentFiles = Array.from(agentIds)
      .map(id => join(directory, `agent-${id}.jsonl`))
      .filter(filePath => existsSync(filePath));

    logger.debug('HOOK', 'Discovered agent transcripts', {
      agentCount: agentIds.size,
      filesFound: agentFiles.length,
      agentFiles: agentFiles.map(f => basename(f))
    });

    return agentFiles;
  } catch (error) {
    logger.warn('HOOK', 'Failed to discover agent files', { mainTranscriptPath }, error as Error);
    return [];
  }
}

// Removed: Complex recursive processToolResultContent function replaced with simple direct approach below

/**
 * Transform main transcript + all linked agent transcripts
 * Auto-discovers agent files and transforms them all
 */
export async function transformTranscriptWithAgents(
  mainTranscriptPath: string,
  toolUseId: string
): Promise<{ originalTokens: number; compressedTokens: number }> {
  // Discover agent files
  const agentFiles = await discoverAgentFiles(mainTranscriptPath);

  // Transform main transcript
  const mainStats = await transformTranscript(mainTranscriptPath, toolUseId);

  // Transform all agent transcripts
  let agentOriginalTokens = 0;
  let agentCompressedTokens = 0;

  for (const agentFile of agentFiles) {
    try {
      const agentStats = await transformTranscript(agentFile, toolUseId);
      agentOriginalTokens += agentStats.originalTokens;
      agentCompressedTokens += agentStats.compressedTokens;
    } catch (error) {
      logger.warn('HOOK', 'Failed to transform agent transcript', { agentFile }, error as Error);
      // Continue with other agents even if one fails
    }
  }

  // Return combined stats
  return {
    originalTokens: mainStats.originalTokens + agentOriginalTokens,
    compressedTokens: mainStats.compressedTokens + agentCompressedTokens
  };
}

/**
 * Transform transcript JSONL file by replacing BOTH tool inputs and outputs with compressed observations
 *
 * Transforms both directions:
 * 1. Assistant entries: Replace tool_use.input with observation (if shorter)
 * 2. User entries: Replace tool_result.content with observation (if shorter)
 * 3. Already-transformed entries skip automatically (observation won't be shorter)
 *
 * ALWAYS creates timestamped backup before transformation for data safety
 *
 * Returns compression stats for tracking
 */
export async function transformTranscript(
  transcriptPath: string,
  toolUseId: string
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

  // Track transformation stats
  const stats = {
    totalOriginalSize: 0,
    totalCompressedSize: 0,
    transformCount: 0
  };

  // Open database connection once for all lookups
  const db = new SessionStore();

  // Process each line - transform BOTH inputs and outputs
  const transformedLines = lines.map((line, i) => {
    if (!line.trim()) return line;

    try {
      const entry: TranscriptEntry = JSON.parse(line);

      if (!Array.isArray(entry.message?.content)) {
        return line; // No content array to process
      }

      let modified = false;

      // Process assistant entries (tool_use = INPUTs)
      if (entry.type === 'assistant') {
        const assistantEntry = entry as AssistantTranscriptEntry;
        assistantEntry.message.content.forEach(item => {
          if (item.type === 'tool_use') {
            const toolUse = item as ToolUseContent;
            if (!toolUse.id) return;

            // Query database for observations
            const observations = db.getAllObservationsForToolUseId(toolUse.id);

            if (observations.length > 0) {
              // Measure original size
              const originalSize = JSON.stringify(toolUse.input).length;

              // Concatenate ALL observations for this tool_use_id (simple separator, no markdown overhead)
              const concatenatedObservations = observations
                .map(obs => formatObservationAsMarkdown(obs))
                .join(' | ');
              const compressedSize = concatenatedObservations.length;

              // Only replace if observation is shorter
              if (compressedSize < originalSize) {
                // Backup original tool input BEFORE compression
                try {
                  appendToolOutput(toolUse.id, JSON.stringify(toolUse.input), Date.now());
                } catch (backupError) {
                  logger.warn('HOOK', 'Failed to backup original tool input', { toolUseId: toolUse.id }, backupError as Error);
                }

                // Replace with compressed observation
                toolUse.input = { _compressed: concatenatedObservations };

                // Track stats
                stats.totalOriginalSize += originalSize;
                stats.totalCompressedSize += compressedSize;
                stats.transformCount++;
                modified = true;

                logger.success('HOOK', 'Transformed tool_use input', {
                  toolUseId: toolUse.id,
                  originalSize,
                  compressedSize,
                  savings: `${Math.round((1 - compressedSize / originalSize) * 100)}%`
                });
              } else {
                logger.debug('HOOK', 'Skipped input transformation (observation not shorter)', {
                  toolUseId: toolUse.id,
                  originalSize,
                  compressedSize
                });
              }
            }
          }
        });
      }

      // Process user entries (tool_result = OUTPUTs)
      if (entry.type === 'user') {
        const userEntry = entry as UserTranscriptEntry;
        userEntry.message.content.forEach(item => {
          if (item.type === 'tool_result') {
            const toolResult = item as ToolResultContent;
            const currentToolUseId = toolResult.tool_use_id;

            if (!currentToolUseId) return;

            // Query database for observations
            const observations = db.getAllObservationsForToolUseId(currentToolUseId);

            if (observations.length > 0) {
              // Measure original size
              const originalSize = JSON.stringify(toolResult.content).length;

              // Concatenate ALL observations for this tool_use_id (simple separator, no markdown overhead)
              const concatenatedObservations = observations
                .map(obs => formatObservationAsMarkdown(obs))
                .join(' | ');
              const compressedSize = concatenatedObservations.length;

              // Only replace if observation is shorter
              if (compressedSize < originalSize) {
                // Backup original tool output BEFORE compression
                try {
                  appendToolOutput(currentToolUseId, JSON.stringify(toolResult.content), Date.now());
                } catch (backupError) {
                  logger.warn('HOOK', 'Failed to backup original tool output', { toolUseId: currentToolUseId }, backupError as Error);
                }

                // Replace with compressed observation
                toolResult.content = concatenatedObservations;

                // Track stats
                stats.totalOriginalSize += originalSize;
                stats.totalCompressedSize += compressedSize;
                stats.transformCount++;
                modified = true;

                logger.success('HOOK', 'Transformed tool_result output', {
                  toolUseId: currentToolUseId,
                  originalSize,
                  compressedSize,
                  savings: `${Math.round((1 - compressedSize / originalSize) * 100)}%`
                });
              } else {
                logger.debug('HOOK', 'Skipped output transformation (observation not shorter)', {
                  toolUseId: currentToolUseId,
                  originalSize,
                  compressedSize
                });
              }
            }
          }
        });
      }

      // Return modified JSON or original line
      return modified ? JSON.stringify(entry) : line;
    } catch (parseError: any) {
      logger.warn('HOOK', 'Malformed JSONL line in transcript', {
        lineIndex: i,
        error: parseError
      });
      throw new Error(`Malformed JSONL line at index ${i}: ${parseError.message}`);
    }
  });

  // Close database connection
  db.close();

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
  const originalTokens = Math.ceil(stats.totalOriginalSize / CHARS_PER_TOKEN);
  const compressedTokens = Math.ceil(stats.totalCompressedSize / CHARS_PER_TOKEN);

  logger.success('HOOK', 'Transcript transformation complete', {
    toolUseId,
    transformCount: stats.transformCount,
    totalOriginalSize: stats.totalOriginalSize,
    totalCompressedSize: stats.totalCompressedSize,
    savings: stats.totalOriginalSize > 0 ? `${Math.round((1 - stats.totalCompressedSize / stats.totalOriginalSize) * 100)}%` : '0%'
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
    process.exit(0);
  }

  const { session_id, cwd, tool_name, tool_input, tool_response, transcript_path, tool_use_id } = input;

  if (SKIP_TOOLS.has(tool_name)) {
    console.log(createHookResponse('PostToolUse', true));
    process.exit(0);
  }

  // Ensure worker is running
  await ensureWorkerRunning();

  const db = new SessionStore();

  // Use createSDKSession for idempotent lookup (same pattern as summary-hook)
  // This works whether the session is 'active' or not, and matches existing session by UUID
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
    sessionDbId,
    claudeSessionId: session_id,
    workerPort: port,
    toolUseId: extractedToolUseId || silentDebug('tool_use_id not found in transcript', { toolName: tool_name }, '(none)')
  });

  // Phase 3: Check if Endless Mode is enabled
  const endlessModeConfig = EndlessModeConfig.getConfig();
  const isEndlessModeEnabled = !!(endlessModeConfig.enabled && extractedToolUseId && transcript_path);

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
    // Set timeout: configurable for Endless Mode (wait for processing), 2s for async
    const timeoutMs = isEndlessModeEnabled ?
      parseInt(
        process.env.CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS ||
        (silentDebug('CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS not set, using default 90000ms'), '90000'),
        10
      ) : 2000;

    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/observations?wait_until_obs_is_saved=${isEndlessModeEnabled}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        tool_input: tool_input !== undefined ? JSON.stringify(tool_input) : '{}',
        tool_response: tool_response !== undefined ? JSON.stringify(tool_response) : '{}',
        prompt_number: promptNumber,
        cwd: cwd || silentDebug('save-hook: cwd missing', { sessionDbId, tool_name }),
        tool_use_id: extractedToolUseId,
        transcript_path: transcript_path || silentDebug('save-hook: transcript_path missing', { sessionDbId, tool_name })
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.failure('HOOK', 'Failed to send observation', {
        sessionDbId,
        status: response.status
      }, errorText);
      // Continue anyway - observation failed but don't block the hook
      console.log(createHookResponse('PostToolUse', true));
      process.exit(0);
    }

    const result = await response.json();

    if (result.status === 'completed') {
      console.log('[save-hook] ✅ Observation created, transcript transformed');
    } else if (result.status === 'skipped') {
      console.log('[save-hook] ⏭️  No observation needed, continuing');
    } else if (result.status === 'timeout') {
      console.warn(`[save-hook] ⏱️  Timeout after ${timeoutMs}ms - processing async`);
    }

    // Transformation now happens in the worker service after observation is saved
    logger.debug('HOOK', 'Observation sent successfully', {
      sessionDbId,
      toolName: tool_name,
      mode: isEndlessModeEnabled ? 'synchronous (Endless Mode)' : 'async'
    });
  } catch (error: any) {
    // Worker connection errors - feed to Claude (exit 2)
    if (error.cause?.code === 'ECONNREFUSED') {
      const errorMsg = `Worker connection failed. Try: pm2 restart claude-mem-worker`;
      logger.failure('HOOK', 'Worker connection refused', { sessionDbId }, error);
      console.error(`[save-hook] ${errorMsg}`);
      console.log(createHookResponse('PostToolUse', false, { reason: errorMsg }));
      process.exit(2); // Exit 2: Feed error to Claude (PostToolUse shows stderr to Claude)
    }

    // All other errors - log and continue (never block the hook)
    console.warn('[save-hook] ❌ Failed to send observation:', error.message);
    logger.warn('HOOK', 'Observation request failed - continuing anyway', {
      sessionDbId,
      toolName: tool_name,
      error: error.message
    });
    console.log(createHookResponse('PostToolUse', true));
    process.exit(0);
  }

  console.log(createHookResponse('PostToolUse', true));
  process.exit(0);
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    const parsed = input ? JSON.parse(input) : undefined;
    await saveHook(parsed);
  } catch (error: any) {
    // Top-level error handler: output JSON + stderr + exit 1 (non-blocking fallback)
    console.error(`[save-hook] Unhandled error: ${error.message}`);
    console.log(createHookResponse('PostToolUse', false, { reason: error.message }));
    process.exit(1);
  }
});
