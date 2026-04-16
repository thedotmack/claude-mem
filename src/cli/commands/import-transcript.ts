/**
 * Import a Claude Code JSONL transcript into claude-mem with historical timestamps.
 *
 * One-shot CLI that replays a completed transcript end-to-end through the
 * worker, stamping observations and the final summary with the original
 * transcript epochs (Phase 1 `historical_timestamp_from_import_epoch_ms`,
 * Phase 2 per-line resolution via schema.timestampPath).
 *
 * Flow:
 *   1. ensureWorkerRunning (skipped in --dry-run)
 *   2. Stream the JSONL file line-by-line with readline
 *   3. Flatten Claude Code `message.content[]` arrays into synthetic per-item
 *      entries so the schema's path-based resolver can reach tool_use/tool_result
 *      fields. Inherits the outer sessionId+timestamp onto each synthetic entry.
 *   4. Per line, call TranscriptEventProcessor.processEntry(entry, watch, schema)
 *   5. Track the LAST valid entry's parsed epoch (ms since UTC)
 *   6. POST /api/sessions/summarize with historical_timestamp_from_import_epoch_ms
 *      = last epoch (triggers SDKAgent compression with historical MIN epoch)
 *   7. Poll /api/sessions/status until queueLength === 0 (or timeout)
 *   8. POST /api/sessions/complete with the same historical epoch
 *
 * Flags:
 *   --schema <path>      JSON file defining a TranscriptSchema. Default: built-in
 *                         Claude Code JSONL schema (below).
 *   --session-id <id>    Override the resolved session id. Default: derived from
 *                         the schema's sessionIdPath.
 *   --dry-run            Parse + report counts. Makes NO HTTP calls and does not
 *                         start the worker.
 *   --timeout-ms <n>     Summarize-completion poll timeout. Default: 60000.
 *
 * Exit codes:
 *   0 = success
 *   1 = recoverable failure (file missing, parse errors only, non-2xx HTTP)
 *   2 = blocking error (worker will not start)
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { basename, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { TranscriptEventProcessor } from '../../services/transcripts/processor.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import type { TranscriptSchema, WatchTarget } from '../../services/transcripts/types.js';

/**
 * Built-in Claude Code JSONL schema.
 *
 * Claude Code's JSONL wraps `tool_use`/`tool_result` inside `message.content[]`
 * arrays. The schema resolver can't iterate arrays, so the CLI FLATTENS each
 * line into one synthetic entry per content item before handing it to the
 * processor. Each synthetic entry carries:
 *   - outer `sessionId`, `timestamp`, `cwd`
 *   - a top-level `toolUse` or `toolResult` object so the schema can resolve
 *     `toolUse.name`, `toolUse.input`, `toolResult.content`, etc. as scalars.
 */
const CLAUDE_CODE_JSONL_SCHEMA: TranscriptSchema = {
  name: 'claude-code',
  version: '1.0',
  description: 'Schema for Claude Code project JSONL transcripts (pre-flattened by importer).',
  sessionIdPath: 'sessionId',
  timestampPath: 'timestamp',
  cwdPath: 'cwd',
  events: [
    {
      name: 'tool-use',
      match: { path: 'toolUse.id', exists: true },
      action: 'tool_use',
      fields: {
        toolId: 'toolUse.id',
        toolName: 'toolUse.name',
        toolInput: 'toolUse.input'
      }
    },
    {
      name: 'tool-result',
      match: { path: 'toolResult.tool_use_id', exists: true },
      action: 'tool_result',
      fields: {
        toolId: 'toolResult.tool_use_id',
        toolResponse: 'toolResult.content'
      }
    },
    {
      name: 'user-text',
      match: { path: 'userText', exists: true },
      action: 'user_message',
      fields: {
        message: 'userText'
      }
    },
    {
      name: 'assistant-text',
      match: { path: 'assistantText', exists: true },
      action: 'assistant_message',
      fields: {
        message: 'assistantText'
      }
    }
  ]
};

interface ParsedArgs {
  path: string | null;
  schemaPath: string | null;
  sessionIdOverride: string | null;
  dryRun: boolean;
  summarizeTimeoutMs: number;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  let schemaPath: string | null = null;
  let sessionIdOverride: string | null = null;
  let dryRun = false;
  let summarizeTimeoutMs = 60_000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--schema') {
      schemaPath = args[++i] ?? null;
    } else if (arg === '--session-id') {
      sessionIdOverride = args[++i] ?? null;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--timeout-ms') {
      const raw = args[++i];
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n > 0) summarizeTimeoutMs = n;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  return {
    path: positional[0] ?? null,
    schemaPath,
    sessionIdOverride,
    dryRun,
    summarizeTimeoutMs
  };
}

function loadSchema(schemaPath: string | null): TranscriptSchema {
  if (!schemaPath) return CLAUDE_CODE_JSONL_SCHEMA;
  const resolved = resolve(schemaPath);
  if (!existsSync(resolved)) {
    throw new Error(`Schema file not found: ${resolved}`);
  }
  const raw = readFileSync(resolved, 'utf-8');
  const parsed = JSON.parse(raw) as TranscriptSchema;
  if (!parsed.name || !Array.isArray(parsed.events)) {
    throw new Error(`Invalid schema file (missing name or events array): ${resolved}`);
  }
  return parsed;
}

/**
 * Expand a raw Claude Code JSONL entry into one or more synthetic entries
 * that the schema resolver can match against. See CLAUDE_CODE_JSONL_SCHEMA
 * above for the shape of synthetic entries.
 *
 * For custom schemas (--schema), the expansion is skipped — the raw entry
 * is passed through as-is, because custom schemas are expected to match
 * against the raw JSONL shape directly.
 */
function expandEntry(entry: any, useBuiltInExpansion: boolean): unknown[] {
  if (!useBuiltInExpansion) return [entry];
  if (!entry || typeof entry !== 'object') return [entry];

  const message = entry.message;
  const content = message?.content;
  const sessionId = entry.sessionId;
  const timestamp = entry.timestamp;
  const cwd = entry.cwd;

  // Non-message lines (queue-operation, session-meta, etc.) — pass through.
  if (!message || !content) return [entry];

  // String content — treat as a single user/assistant text message.
  if (typeof content === 'string') {
    if (message.role === 'user') {
      return [{ sessionId, timestamp, cwd, userText: content }];
    }
    if (message.role === 'assistant') {
      return [{ sessionId, timestamp, cwd, assistantText: content }];
    }
    return [];
  }

  if (!Array.isArray(content)) return [];

  const synthetic: unknown[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const itemType = (item as any).type;
    if (itemType === 'tool_use') {
      synthetic.push({ sessionId, timestamp, cwd, toolUse: item });
    } else if (itemType === 'tool_result') {
      synthetic.push({ sessionId, timestamp, cwd, toolResult: item });
    } else if (itemType === 'text' && message.role === 'assistant') {
      synthetic.push({ sessionId, timestamp, cwd, assistantText: (item as any).text });
    } else if (itemType === 'text' && message.role === 'user') {
      synthetic.push({ sessionId, timestamp, cwd, userText: (item as any).text });
    }
    // thinking/tool_use_id-only blocks etc. are intentionally skipped.
  }
  return synthetic;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function pollForSummarizeComplete(
  sessionId: string,
  timeoutMs: number
): Promise<{ completed: boolean; summaryStored: boolean | null }> {
  const start = Date.now();
  const pollInterval = 750;
  let summaryStored: boolean | null = null;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, pollInterval));
    try {
      const response = await workerHttpRequest(
        `/api/sessions/status?contentSessionId=${encodeURIComponent(sessionId)}`,
        { timeoutMs: 5_000 }
      );
      if (!response.ok) continue;
      const status = await response.json() as {
        status?: string;
        queueLength?: number;
        summaryStored?: boolean | null;
      };
      const queueLength = status.queueLength ?? 0;
      if (queueLength === 0 && status.status !== 'not_found') {
        summaryStored = status.summaryStored ?? null;
        return { completed: true, summaryStored };
      }
    } catch {
      // keep polling
    }
  }
  return { completed: false, summaryStored };
}

function printUsage(): void {
  console.log('Usage: claude-mem import <transcript.jsonl> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --schema <path>      JSON file with a TranscriptSchema (default: built-in Claude Code)');
  console.log('  --session-id <id>    Override resolved session id');
  console.log('  --dry-run            Parse + report counts; no HTTP calls');
  console.log('  --timeout-ms <n>     Summarize poll timeout (default 60000)');
}

export async function runImportTranscriptCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);

  if (!parsed.path) {
    printUsage();
    return 1;
  }
  const filePath = resolve(parsed.path);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return 1;
  }

  let schema: TranscriptSchema;
  try {
    schema = loadSchema(parsed.schemaPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // Only flatten Claude Code entries when using the built-in schema.
  const useBuiltInExpansion = parsed.schemaPath === null;

  const watch: WatchTarget = {
    name: `import:${basename(filePath)}`,
    path: filePath,
    schema
  };

  if (!parsed.dryRun) {
    const ready = await ensureWorkerRunning();
    if (!ready) {
      console.error('Worker is not healthy; cannot import without it. Try: claude-mem start');
      return 2;
    }
  }

  const processor = new TranscriptEventProcessor();
  let lineCount = 0;
  let parseErrors = 0;
  let eventCount = 0;
  let lastEpochMs: number | undefined;
  let resolvedSessionId: string | null = parsed.sessionIdOverride;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    lineCount++;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch (err) {
      parseErrors++;
      logger.warn('SESSION', 'Failed to parse JSONL line', {
        lineNumber: lineCount,
        preview: trimmed.slice(0, 80),
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    // Track last parsed timestamp (prefer the outer-entry timestamp; synthetic
    // children inherit it, so reading it off the raw entry is correct).
    const ts = parseTimestampMs(entry?.timestamp);
    if (ts !== undefined) lastEpochMs = ts;

    // Capture session id from the first entry that carries one (unless overridden).
    if (!resolvedSessionId && typeof entry?.sessionId === 'string' && entry.sessionId.trim()) {
      resolvedSessionId = entry.sessionId;
    }

    const syntheticEntries = expandEntry(entry, useBuiltInExpansion);
    for (const synthetic of syntheticEntries) {
      eventCount++;
      if (parsed.dryRun) continue;
      try {
        await processor.processEntry(
          synthetic,
          watch,
          schema,
          parsed.sessionIdOverride ?? undefined
        );
      } catch (err) {
        logger.warn('SESSION', 'processEntry threw; continuing', {
          lineNumber: lineCount,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  if (parsed.dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      file: filePath,
      lines: lineCount,
      parseErrors,
      events: eventCount,
      resolvedSessionId,
      lastEpochMs,
      lastEpochIso: lastEpochMs !== undefined ? new Date(lastEpochMs).toISOString() : null,
      schemaName: schema.name
    }, null, 2));
    return 0;
  }

  if (!resolvedSessionId) {
    console.error('No session id resolved (schema sessionIdPath missed, and no --session-id override). Aborting.');
    return 1;
  }

  // Fallback: if we never saw a valid timestamp, omit the field entirely and
  // let the worker fall back to now() (Phase 1 conditional-spread pattern).
  logger.info('SESSION', 'Stream complete, requesting summarize', {
    file: filePath,
    lines: lineCount,
    parseErrors,
    events: eventCount,
    resolvedSessionId,
    lastEpochIso: lastEpochMs !== undefined ? new Date(lastEpochMs).toISOString() : null
  });

  // Summarize — triggers SDKAgent compression with historical timestamps.
  try {
    const response = await workerHttpRequest('/api/sessions/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: resolvedSessionId,
        last_assistant_message: '',
        ...(lastEpochMs !== undefined
          ? { historical_timestamp_from_import_epoch_ms: lastEpochMs }
          : {})
      }),
      timeoutMs: 30_000
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`summarize failed: HTTP ${response.status} body=${body}`);
      return 1;
    }
  } catch (err) {
    console.error(`summarize request error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Poll until compression drains.
  const pollResult = await pollForSummarizeComplete(resolvedSessionId, parsed.summarizeTimeoutMs);
  if (!pollResult.completed) {
    logger.error('SESSION', `summarize did not complete within ${parsed.summarizeTimeoutMs}ms; not calling /complete. Try increasing --timeout-ms or check worker logs.`, {
      timeoutMs: parsed.summarizeTimeoutMs
    });
    return 1;
  }

  // Complete — stamps sdk_sessions.completed_at_epoch historically.
  try {
    const response = await workerHttpRequest('/api/sessions/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: resolvedSessionId,
        ...(lastEpochMs !== undefined
          ? { historical_timestamp_from_import_epoch_ms: lastEpochMs }
          : {})
      }),
      timeoutMs: 10_000
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`complete failed: HTTP ${response.status} body=${body}`);
      return 1;
    }
  } catch (err) {
    console.error(`complete request error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(JSON.stringify({
    mode: 'import',
    file: filePath,
    lines: lineCount,
    parseErrors,
    events: eventCount,
    resolvedSessionId,
    lastEpochMs,
    lastEpochIso: lastEpochMs !== undefined ? new Date(lastEpochMs).toISOString() : null,
    summarizeCompleted: pollResult.completed,
    summaryStored: pollResult.summaryStored
  }, null, 2));
  return 0;
}
