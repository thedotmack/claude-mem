/**
 * Claude Code JSONL Backfill Processor
 *
 * Reads historical Claude Code session JSONL files and submits them
 * through the existing handler pipeline (session-init, observation,
 * summarize, session-complete).
 *
 * Uses a dedicated parser rather than the schema-based transcript watcher
 * because Claude Code's nested content format (tool_use inside assistant
 * content arrays, tool_result inside user content arrays) requires native
 * parsing beyond the schema system's single-path matching.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { globSync } from 'glob';
import { sessionInitHandler } from '../../cli/handlers/session-init.js';
import { observationHandler } from '../../cli/handlers/observation.js';
import { sessionCompleteHandler } from '../../cli/handlers/session-complete.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackfillState {
  processedFiles: Record<string, { processedAt: string; observations: number }>;
  lastRun?: string;
}

/** Options for controlling the transcript backfill process. */
export interface BackfillOptions {
  path?: string;
  dryRun?: boolean;
  limit?: number;
  delayMs?: number;
  force?: boolean;
}

/** Statistics returned after a backfill run completes. */
export interface BackfillStats {
  filesFound: number;
  filesProcessed: number;
  filesSkipped: number;
  sessionsCreated: number;
  observationsSent: number;
  errors: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | ContentBlock[];
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeCodeEvent {
  type: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    stop_reason?: string;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
  };
}

interface ToolObservation {
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
}

// ---------------------------------------------------------------------------
// State persistence (resume support)
// ---------------------------------------------------------------------------

const STATE_PATH = join(homedir(), '.claude-mem', 'backfill-state.json');

/** Load persisted backfill state from disk for resume support. */
function loadBackfillState(): BackfillState {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    } catch {
      return { processedFiles: {} };
    }
  }
  return { processedFiles: {} };
}

/** Persist backfill state to disk so interrupted runs can resume. */
function saveBackfillState(state: BackfillState): void {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// JSONL parsing helpers
// ---------------------------------------------------------------------------

function parseJsonlFile(filePath: string): ClaudeCodeEvent[] {
  const content = readFileSync(filePath, 'utf-8');
  const events: ClaudeCodeEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

/** Extract a UUID session ID from a JSONL filename, or null if the name is not a valid UUID. */
function extractSessionId(filePath: string): string | null {
  const name = basename(filePath, '.jsonl');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(name) ? name : null;
}

/** Extract the working directory from the first event that carries a `cwd` field. */
function extractCwd(events: ClaudeCodeEvent[]): string {
  for (const event of events) {
    if (event.cwd) return event.cwd;
  }
  return process.cwd();
}

/** Extract the first non-meta user text prompt from a session's events. */
function extractFirstUserPrompt(events: ClaudeCodeEvent[]): string | null {
  for (const event of events) {
    if (event.type !== 'user') continue;
    if (event.isMeta) continue;
    if (!event.message?.content) continue;
    // User text messages have string content; tool results have array content
    if (typeof event.message.content === 'string') {
      const text = event.message.content.trim();
      if (text) return text;
    }
  }
  return null;
}

/** Extract the last text block from the final assistant message in the event stream. */
function extractLastAssistantMessage(events: ClaudeCodeEvent[]): string {
  let lastText = '';
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    if (!event.message?.content || !Array.isArray(event.message.content)) continue;
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        lastText = block.text;
      }
    }
  }
  return lastText;
}

/** Pair tool_use requests with their corresponding tool_result responses into observations. */
function extractToolObservations(events: ClaudeCodeEvent[]): ToolObservation[] {
  const observations: ToolObservation[] = [];
  const pendingTools = new Map<string, { name: string; input: unknown }>();

  for (const event of events) {
    // Assistant messages contain tool_use blocks
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message!.content as ContentBlock[]) {
        if (block.type === 'tool_use' && block.id && block.name) {
          pendingTools.set(block.id, { name: block.name, input: block.input });
        }
      }
    }

    // User messages with toolUseResult contain tool results
    if (event.type === 'user' && event.toolUseResult) {
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const pending = pendingTools.get(block.tool_use_id);
          if (pending) {
            observations.push({
              toolName: pending.name,
              toolInput: pending.input,
              toolResponse: typeof block.content === 'string'
                ? block.content
                : event.toolUseResult
            });
            pendingTools.delete(block.tool_use_id);
          }
        }
      }
    }
  }

  return observations;
}

// ---------------------------------------------------------------------------
// Main backfill
// ---------------------------------------------------------------------------

export async function runBackfill(options: BackfillOptions = {}): Promise<BackfillStats> {
  const stats: BackfillStats = {
    filesFound: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    sessionsCreated: 0,
    observationsSent: 0,
    errors: 0
  };

  const defaultPath = join(homedir(), '.claude', 'projects', '**', '*.jsonl').replaceAll('\\', '/');
  const globPattern = (options.path ?? defaultPath).replaceAll('\\', '/');
  const dryRun = options.dryRun ?? false;
  const limit = options.limit ?? Infinity;
  const delayMs = options.delayMs ?? 500;
  const force = options.force ?? false;

  // Discover JSONL files
  const files = globSync(globPattern, { nodir: true, absolute: true })
    .filter(f => f.endsWith('.jsonl'));
  stats.filesFound = files.length;

  if (files.length === 0) {
    console.log('No JSONL files found matching pattern:', globPattern);
    return stats;
  }

  console.log(`Found ${files.length} JSONL file(s)`);

  // Load state for resume support
  const state = loadBackfillState();

  // Filter already-processed files unless --force
  const toProcess = force
    ? files
    : files.filter(f => !state.processedFiles[f]);
  stats.filesSkipped = files.length - toProcess.length;

  if (toProcess.length === 0) {
    console.log('All files already processed. Use --force to re-process.');
    return stats;
  }

  const batch = toProcess.slice(0, limit);
  console.log(`Processing ${batch.length} of ${toProcess.length} unprocessed file(s)${dryRun ? ' (dry run)' : ''}\n`);

  if (!dryRun) {
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      console.error('Worker is not running. Start it with: npx claude-mem start');
      return stats;
    }
  }

  for (const filePath of batch) {
    const sessionId = extractSessionId(filePath);
    if (!sessionId) {
      logger.debug('SYSTEM', 'Backfill: skipping non-session file', { filePath });
      stats.filesSkipped++;
      continue;
    }

    try {
      const events = parseJsonlFile(filePath);
      if (events.length === 0) {
        stats.filesSkipped++;
        continue;
      }

      const cwd = extractCwd(events);
      const prompt = extractFirstUserPrompt(events);
      const observations = extractToolObservations(events);
      const lastAssistant = extractLastAssistantMessage(events);

      if (dryRun) {
        const truncatedPrompt = prompt
          ? prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt
          : '(no prompt)';
        console.log(`  ${basename(filePath)}: ${observations.length} tool calls, prompt: "${truncatedPrompt}"`);
        stats.filesProcessed++;
        stats.observationsSent += observations.length;
        if (prompt) stats.sessionsCreated++;
        continue;
      }

      // 1. Initialize session with first user prompt
      if (prompt) {
        await sessionInitHandler.execute({
          sessionId,
          cwd,
          prompt,
          platform: 'claude-code'
        });
        stats.sessionsCreated++;
      }

      // 2. Submit tool observations
      for (const obs of observations) {
        await observationHandler.execute({
          sessionId,
          cwd,
          toolName: obs.toolName,
          toolInput: obs.toolInput,
          toolResponse: obs.toolResponse,
          platform: 'claude-code'
        });
        stats.observationsSent++;
      }

      // 3. Queue summary from last assistant message
      if (lastAssistant) {
        try {
          await workerHttpRequest('/api/sessions/summarize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contentSessionId: sessionId,
              last_assistant_message: lastAssistant,
              platformSource: 'claude'
            })
          });
        } catch {
          // Summary is best-effort
        }
      }

      // 4. Complete session
      await sessionCompleteHandler.execute({
        sessionId,
        cwd,
        platform: 'claude-code'
      });

      stats.filesProcessed++;
      state.processedFiles[filePath] = {
        processedAt: new Date().toISOString(),
        observations: observations.length
      };
      saveBackfillState(state);

      console.log(`  ✓ ${basename(filePath)}: ${observations.length} observations`);

      // Rate-limit between sessions to avoid overwhelming the worker AI queue
      if (delayMs > 0 && batch.indexOf(filePath) < batch.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      stats.errors++;
      console.error(`  ✗ ${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  state.lastRun = new Date().toISOString();
  saveBackfillState(state);

  return stats;
}
