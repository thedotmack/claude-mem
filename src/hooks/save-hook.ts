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
import { happy_path_error__with_fallback, silentDebug } from '../utils/silent-debug.js';
import { BACKUPS_DIR, createBackupFilename, ensureDir } from '../shared/paths.js';
import { appendToolOutput, trimBackupFile } from '../shared/tool-output-backup.js';
import type { TranscriptEntry, AssistantTranscriptEntry, ToolUseContent, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';
import type { Observation } from '../services/worker-types.js';
import { stripMemoryTagsFromJson } from '../utils/tag-stripping.js';
import { clearToolInputInTranscript, injectObservationFetchInTranscript } from './context-injection.js';

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
 * Format observation as markdown section
 * Creates a structured markdown block with the observation title as heading
 */
export function formatObservationAsMarkdown(obs: Observation): string {
  const parts: string[] = [];

  // Title as markdown heading
  parts.push(`## ${obs.title}`);

  // Subtitle (if present)
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

  // Join with double newlines for markdown formatting
  return parts.join('\n\n');
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
  toolUseId: string,
  toolUsesInCurrentCycle: string[] = []
): Promise<{ originalTokens: number; compressedTokens: number }> {
  // Discover agent files
  const agentFiles = await discoverAgentFiles(mainTranscriptPath);

  // Transform main transcript
  const mainStats = await transformTranscript(mainTranscriptPath, toolUseId, toolUsesInCurrentCycle);

  // Transform all agent transcripts (agents maintain separate timeline state)
  let agentOriginalTokens = 0;
  let agentCompressedTokens = 0;

  for (const agentFile of agentFiles) {
    try {
      // Agents get empty cycle array - they track their own timeline independently
      const agentStats = await transformTranscript(agentFile, toolUseId, []);
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
 * Transform transcript using rolling replacement strategy
 *
 * Key concept: Replace ALL tool uses between last observation and current observation
 * with a single assistant message containing all observations in markdown format.
 *
 * This creates a "rolling replacement" where:
 * - User prompt → tools execute → observations arrive
 * - When observations arrive, ALL preceding tool uses get replaced
 * - Next user prompt → more tools → more observations arrive
 * - Process repeats, progressively compressing the transcript
 *
 * ALWAYS creates timestamped backup before transformation for data safety
 * Returns compression stats for tracking
 */
export async function transformTranscript(
  transcriptPath: string,
  toolUseId: string,
  toolUsesInCurrentCycle: string[] = []
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

  // Fetch ALL observations for current tool_use_id (including suffixed ones like toolu_123__1, toolu_123__2)
  const allObservations = db.getAllObservationsForToolUseId(toolUseId);

  if (allObservations.length === 0) {
    // No observations to process - return unchanged
    db.close();
    logger.debug('HOOK', 'No observations found for rolling replacement', { toolUseId });
    return { originalTokens: 0, compressedTokens: 0 };
  }

  // Build the set of tool_use_ids to replace (current cycle)
  const toolIdsToReplace = new Set(toolUsesInCurrentCycle);
  toolIdsToReplace.add(toolUseId); // Always include current tool

  logger.info('HOOK', 'Rolling replacement scope', {
    toolUseId,
    cycleSize: toolIdsToReplace.size,
    observationCount: allObservations.length
  });

  // Format all observations as markdown sections
  const observationMarkdown = allObservations
    .map(obs => formatObservationAsMarkdown(obs))
    .join('\n\n');

  // Build replacement assistant message
  const assistantMessage: AssistantTranscriptEntry = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: observationMarkdown
      }]
    }
  };

  const compressedSize = observationMarkdown.length;

  // Pre-scan transcript to validate tool_use/tool_result pairs exist
  // Only remove pairs when BOTH exist to avoid breaking API contract
  const validatedToolIds = new Set<string>();
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry: TranscriptEntry = JSON.parse(line);

      // Track tool_use blocks
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const item of entry.message.content) {
          if (item.type === 'tool_use') {
            const toolUse = item as ToolUseContent;
            if (toolUse.id && toolIdsToReplace.has(toolUse.id)) {
              toolUseIds.add(toolUse.id);
            }
          }
        }
      }

      // Track tool_result blocks
      if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
        for (const item of entry.message.content) {
          if (item.type === 'tool_result') {
            const toolResult = item as ToolResultContent;
            if (toolResult.tool_use_id && toolIdsToReplace.has(toolResult.tool_use_id)) {
              toolResultIds.add(toolResult.tool_use_id);
            }
          }
        }
      }
    } catch {
      // Skip malformed lines during pre-scan
      continue;
    }
  }

  // Only replace tool_use_ids where BOTH blocks exist
  for (const toolId of toolIdsToReplace) {
    if (toolUseIds.has(toolId) && toolResultIds.has(toolId)) {
      validatedToolIds.add(toolId);
    }
  }

  logger.info('HOOK', 'Validated tool pairs for replacement', {
    requestedIds: toolIdsToReplace.size,
    validatedIds: validatedToolIds.size,
    toolUseOnly: Array.from(toolUseIds).filter(id => !toolResultIds.has(id)),
    toolResultOnly: Array.from(toolResultIds).filter(id => !toolUseIds.has(id))
  });

  // If no validated pairs, skip transformation
  if (validatedToolIds.size === 0) {
    db.close();
    logger.debug('HOOK', 'No complete tool_use/tool_result pairs found for replacement', { toolUseId });
    return { originalTokens: 0, compressedTokens: 0 };
  }

  // Parse transcript and identify replacement zone
  const transformedLines: string[] = [];
  let inReplacementZone = false;
  let replacementZoneStart = -1;
  let replacementZoneOriginalSize = 0;
  let skipNextUserEntry = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      transformedLines.push(line);
      continue;
    }

    try {
      const entry: TranscriptEntry = JSON.parse(line);

      // Check if this assistant entry contains a tool_use we need to replace
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        const assistantEntry = entry as AssistantTranscriptEntry;

        for (const item of assistantEntry.message.content) {
          if (item.type === 'tool_use') {
            const toolUse = item as ToolUseContent;

            if (toolUse.id && validatedToolIds.has(toolUse.id)) {
              // Start replacement zone
              if (!inReplacementZone) {
                inReplacementZone = true;
                replacementZoneStart = i;
                logger.debug('HOOK', 'Replacement zone start', { toolUseId: toolUse.id, lineIndex: i });
              }

              // Backup original tool input
              try {
                appendToolOutput(toolUse.id, JSON.stringify(toolUse.input), Date.now());
              } catch (backupError) {
                logger.warn('HOOK', 'Failed to backup original tool input', { toolUseId: toolUse.id }, backupError as Error);
              }

              // Measure original size
              replacementZoneOriginalSize += line.length;
              skipNextUserEntry = true; // Skip the corresponding tool_result
              break; // Found a match in this entry
            }
          }
        }

        // If we're in replacement zone, skip this line (will be replaced)
        if (inReplacementZone && skipNextUserEntry) {
          continue;
        }
      }

      // Check if this user entry contains a tool_result we need to replace
      if (entry.type === 'user' && Array.isArray(entry.message?.content) && skipNextUserEntry) {
        const userEntry = entry as UserTranscriptEntry;

        for (const item of userEntry.message.content) {
          if (item.type === 'tool_result') {
            const toolResult = item as ToolResultContent;

            if (toolResult.tool_use_id && validatedToolIds.has(toolResult.tool_use_id)) {
              // Backup original tool output
              try {
                appendToolOutput(toolResult.tool_use_id, JSON.stringify(toolResult.content), Date.now());
              } catch (backupError) {
                logger.warn('HOOK', 'Failed to backup original tool output', { toolUseId: toolResult.tool_use_id }, backupError as Error);
              }

              // Measure original size
              replacementZoneOriginalSize += line.length;

              // Check if this is the LAST tool_result in our replacement zone
              const isLastToolResult = toolResult.tool_use_id === toolUseId;

              if (isLastToolResult) {
                // End of replacement zone - insert consolidated assistant message
                transformedLines.push(JSON.stringify(assistantMessage));

                inReplacementZone = false;
                skipNextUserEntry = false;

                stats.totalOriginalSize += replacementZoneOriginalSize;
                stats.totalCompressedSize += compressedSize;
                stats.transformCount++;

                logger.success('HOOK', 'Rolling replacement complete', {
                  zoneStart: replacementZoneStart,
                  zoneEnd: i,
                  toolsReplaced: validatedToolIds.size,
                  originalSize: replacementZoneOriginalSize,
                  compressedSize,
                  savings: `${Math.round((1 - compressedSize / replacementZoneOriginalSize) * 100)}%`
                });
              }

              continue; // Skip this tool_result line
            }
          }
        }
      }

      // Not in replacement zone or not a target - keep original line
      if (!inReplacementZone || !skipNextUserEntry) {
        transformedLines.push(line);
      }
    } catch (parseError: any) {
      logger.warn('HOOK', 'Malformed JSONL line in transcript', {
        lineIndex: i,
        error: parseError
      });
      throw new Error(`Malformed JSONL line at index ${i}: ${parseError.message}`);
    }
  }

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

  // Skip observation if user prompt was entirely private
  // This respects the user's intent: if they marked the entire prompt as <private>,
  // they don't want ANY observations from that interaction
  const userPrompt = db.getUserPrompt(session_id, promptNumber);
  if (!userPrompt || userPrompt.trim() === '') {
    silentDebug('[save-hook] Skipping observation - user prompt was entirely private', {
      session_id,
      promptNumber,
      tool_name
    });
    db.close();
    console.log(createHookResponse('PostToolUse', true));
    return;
  }

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
      happy_path_error__with_fallback('Failed to extract tool_use_id from transcript', { error });
    }
  }

  logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
    sessionDbId,
    claudeSessionId: session_id,
    workerPort: port,
    toolUseId: extractedToolUseId || happy_path_error__with_fallback('tool_use_id not found in transcript', { toolName: tool_name }, '(none)')
  });

  // Phase 3: Check if Endless Mode is enabled
  const endlessModeConfig = EndlessModeConfig.getConfig();
  const isEndlessModeEnabled = !!(endlessModeConfig.enabled && extractedToolUseId && transcript_path);

  // Debug logging for endless mode conditions AND all input fields
  happy_path_error__with_fallback('Endless Mode Check', {
    configEnabled: endlessModeConfig.enabled,
    hasToolUseId: !!extractedToolUseId,
    hasTranscriptPath: !!transcript_path,
    isEndlessModeEnabled,
    toolName: tool_name,
    toolUseId: extractedToolUseId,
    allInputKeys: Object.keys(input).join(', ')
  });

  try {
    // Serialize and strip memory tags from tool_input and tool_response
    // This prevents recursive storage of context and respects <private> tags
    let cleanedToolInput = '{}';
    let cleanedToolResponse = '{}';

    try {
      cleanedToolInput = tool_input !== undefined
        ? stripMemoryTagsFromJson(JSON.stringify(tool_input))
        : '{}';
    } catch (error) {
      // Handle circular references or other JSON.stringify errors
      silentDebug('[save-hook] Failed to stringify tool_input:', { error, tool_name });
      cleanedToolInput = '{"error": "Failed to serialize tool_input"}';
    }

    try {
      cleanedToolResponse = tool_response !== undefined
        ? stripMemoryTagsFromJson(JSON.stringify(tool_response))
        : '{}';
    } catch (error) {
      // Handle circular references or other JSON.stringify errors
      silentDebug('[save-hook] Failed to stringify tool_response:', { error, tool_name });
      cleanedToolResponse = '{"error": "Failed to serialize tool_response"}';
    }

    // Set timeout: configurable for Endless Mode (wait for processing), 2s for async
    const timeoutMs = isEndlessModeEnabled ?
      parseInt(
        process.env.CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS ||
        (happy_path_error__with_fallback('CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS not set, using default 90000ms'), '90000'),
        10
      ) : 2000;

    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/observations?wait_until_obs_is_saved=${isEndlessModeEnabled}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        tool_input: cleanedToolInput,
        tool_response: cleanedToolResponse,
        prompt_number: promptNumber,
        cwd: cwd || happy_path_error__with_fallback('save-hook: cwd missing', { sessionDbId, tool_name }),
        tool_use_id: extractedToolUseId,
        transcript_path: transcript_path || happy_path_error__with_fallback('save-hook: transcript_path missing', { sessionDbId, tool_name })
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

    if (result.status === 'completed' && isEndlessModeEnabled) {
      // NEW APPROACH: Clear tool input and inject observation fetch
      try {
        // Step 1: Clear tool input from transcript
        if (extractedToolUseId && transcript_path) {
          const tokensSaved = await clearToolInputInTranscript(transcript_path, extractedToolUseId);
          logger.info('HOOK', 'Cleared tool input from transcript', {
            toolUseId: extractedToolUseId,
            tokensSaved
          });
        }

        // Step 2: Inject observation fetch as a tool_use in transcript
        if (result.observation && transcript_path) {
          await injectObservationFetchInTranscript(
            transcript_path,
            session_id,
            cwd,
            [result.observation]
          );
          logger.success('HOOK', 'Injected observation fetch in transcript', {
            observationId: result.observation.id
          });
        }

        console.log('[save-hook] ✅ Observation created, context injected naturally');
      } catch (transformError) {
        logger.error('HOOK', 'Failed to inject context', {}, transformError as Error);
        // Continue anyway - don't block the hook
      }
    } else if (result.status === 'completed') {
      console.log('[save-hook] ✅ Observation created');
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
