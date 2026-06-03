/**
 * Claude Code transcript backfill (upstream #2690) — scan + dry-run.
 *
 * This module is the client-side, spend-free half of the backfill:
 *  - `scanSource()` enumerates the parent sessions (one `*.jsonl` per session)
 *    and, when requested, their subagent sessions.
 *  - `dryRunSource()` parses + normalizes every line and counts what a real
 *    ingest WOULD produce, WITHOUT calling `ingestObservation` (i.e. without
 *    any Haiku spend). This is the cost gate: see the per-session and total
 *    observation/summary estimates before spending.
 *
 * The real (spending) ingest is driven inside the worker process over HTTP
 * (ingestObservation needs setIngestContext) and lands in a follow-up.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { expandHomePath } from './config.js';
import { normalizeClaudeCodeLine } from './claude-code.js';

export interface SubagentRef {
  /** content_session_id used for the subagent: `agent-<id>`. */
  sessionId: string;
  filePath: string;
  agentType?: string;
  description?: string;
}

export interface SessionRef {
  /** content_session_id (the parent session UUID, = filename without .jsonl). */
  sessionId: string;
  filePath: string;
  subagents: SubagentRef[];
}

export interface ScanOptions {
  includeSubagents?: boolean;
}

const JSONL_EXT = '.jsonl';

/**
 * Cost-estimate constants. These are deliberately explicit and tunable — they
 * are an ESTIMATE, not a billing guarantee.
 *
 * Caveat: the worker's observation generator may prepend per-session
 * conversation history to each call, so real input can exceed the raw payload
 * bytes counted here. Treat the input-token figure as a floor.
 */
const CHARS_PER_TOKEN = 4; // rough industry approximation (JSON skews a bit denser)
const PROMPT_OVERHEAD_TOKENS = 400; // scaffolding/instructions sent per generation call
const OUTPUT_TOKENS_PER_OBSERVATION = 250;
const OUTPUT_TOKENS_PER_SUMMARY = 400;
// Claude Haiku 4.5 list pricing (USD per million tokens). Adjust if the worker
// is pointed at a different model, or set to 0 if Haiku runs on subscription
// budget rather than metered API billing.
const HAIKU_USD_PER_MTOK_INPUT = 1.0;
const HAIKU_USD_PER_MTOK_OUTPUT = 5.0;

function listSubagents(parentFilePath: string, sessionId: string): SubagentRef[] {
  // Subagents live at <dir>/<sessionId>/subagents/agent-<id>.jsonl with a
  // sibling agent-<id>.meta.json ({ agentType, description, [worktreePath] }).
  const subDir = join(dirname(parentFilePath), sessionId, 'subagents');
  if (!existsSync(subDir) || !statSync(subDir).isDirectory()) return [];

  const refs: SubagentRef[] = [];
  for (const name of readdirSync(subDir)) {
    if (!name.startsWith('agent-') || !name.endsWith(JSONL_EXT)) continue;
    const filePath = join(subDir, name);
    const agentId = basename(name, JSONL_EXT); // e.g. agent-a7a74e8d...
    const ref: SubagentRef = { sessionId: agentId, filePath };

    const metaPath = join(subDir, `${agentId}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
          agentType?: string;
          description?: string;
        };
        if (typeof meta.agentType === 'string') ref.agentType = meta.agentType;
        if (typeof meta.description === 'string') ref.description = meta.description;
      } catch {
        // Malformed meta is non-fatal — ingest the agent session without it.
      }
    }
    refs.push(ref);
  }
  return refs;
}

/**
 * Enumerate parent sessions (and optionally subagents) under `source`.
 * `source` may be a single `*.jsonl` file or a directory of them (one repo).
 */
export function scanSource(source: string, options: ScanOptions = {}): SessionRef[] {
  const resolved = expandHomePath(source);
  if (!existsSync(resolved)) {
    throw new Error(`ingest source not found: ${resolved}`);
  }

  let parentFiles: string[];
  const stat = statSync(resolved);
  if (stat.isFile()) {
    if (!resolved.endsWith(JSONL_EXT)) {
      throw new Error(`ingest source file is not a .jsonl: ${resolved}`);
    }
    parentFiles = [resolved];
  } else {
    parentFiles = readdirSync(resolved)
      .filter(name => name.endsWith(JSONL_EXT))
      .map(name => join(resolved, name))
      .filter(p => statSync(p).isFile());
  }

  return parentFiles.map(filePath => {
    const sessionId = basename(filePath, JSONL_EXT);
    const subagents = options.includeSubagents ? listSubagents(filePath, sessionId) : [];
    return { sessionId, filePath, subagents };
  });
}

export interface SessionCounts {
  sessionId: string;
  filePath: string;
  isSubagent: boolean;
  agentType?: string;
  lines: number;
  parseFailures: number;
  userPrompts: number;
  assistantTexts: number;
  toolUses: number;
  toolResults: number;
  /** Bytes of model-visible content (tool inputs/responses, prompts, replies). */
  contentBytes: number;
}

export interface DryRunReport {
  source: string;
  includeSubagents: boolean;
  sessions: SessionCounts[];
  totals: {
    sessions: number;
    parseFailures: number;
    /** Each completed tool call becomes one observation (one Haiku generation). */
    estimatedObservations: number;
    /** One summary per session (one Haiku generation) at session_end. */
    estimatedSummaries: number;
    /** estimatedObservations + estimatedSummaries — the Haiku-call proxy. */
    estimatedHaikuCalls: number;
    contentBytes: number;
    /** Estimated input tokens (content + per-call prompt overhead). A floor. */
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    /** Estimated metered cost in USD at the Haiku rates above (0 if on subscription). */
    estimatedCostUsd: number;
  };
}

function countFile(filePath: string): Omit<SessionCounts, 'sessionId' | 'isSubagent' | 'agentType'> {
  const counts = {
    filePath,
    lines: 0,
    parseFailures: 0,
    userPrompts: 0,
    assistantTexts: 0,
    toolUses: 0,
    toolResults: 0,
    contentBytes: 0,
  };

  const byteLen = (value: unknown): number => {
    if (value === undefined || value === null) return 0;
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return Buffer.byteLength(s, 'utf-8');
  };

  const raw = readFileSync(filePath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    counts.lines++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      counts.parseFailures++;
      continue;
    }
    for (const ev of normalizeClaudeCodeLine(parsed)) {
      switch (ev.__cc) {
        case 'user_prompt': counts.userPrompts++; counts.contentBytes += byteLen(ev.prompt); break;
        case 'assistant_text': counts.assistantTexts++; counts.contentBytes += byteLen(ev.message); break;
        case 'tool_use': counts.toolUses++; counts.contentBytes += byteLen(ev.toolInput); break;
        case 'tool_result': counts.toolResults++; counts.contentBytes += byteLen(ev.toolResponse); break;
      }
    }
  }
  return counts;
}

/**
 * Parse + normalize every session under `source` and report what a real ingest
 * would produce. No `ingestObservation`, no worker, no Haiku spend.
 */
export function dryRunSource(source: string, options: ScanOptions = {}): DryRunReport {
  const includeSubagents = options.includeSubagents ?? false;
  const refs = scanSource(source, { includeSubagents });

  const sessions: SessionCounts[] = [];
  for (const ref of refs) {
    sessions.push({ ...countFile(ref.filePath), sessionId: ref.sessionId, isSubagent: false });
    for (const sub of ref.subagents) {
      sessions.push({
        ...countFile(sub.filePath),
        sessionId: sub.sessionId,
        isSubagent: true,
        agentType: sub.agentType,
      });
    }
  }

  const estimatedObservations = sessions.reduce((n, s) => n + s.toolUses, 0);
  const estimatedSummaries = sessions.length;
  const estimatedHaikuCalls = estimatedObservations + estimatedSummaries;
  const contentBytes = sessions.reduce((n, s) => n + s.contentBytes, 0);

  const estimatedInputTokens =
    Math.round(contentBytes / CHARS_PER_TOKEN) + estimatedHaikuCalls * PROMPT_OVERHEAD_TOKENS;
  const estimatedOutputTokens =
    estimatedObservations * OUTPUT_TOKENS_PER_OBSERVATION +
    estimatedSummaries * OUTPUT_TOKENS_PER_SUMMARY;
  const estimatedCostUsd =
    (estimatedInputTokens / 1_000_000) * HAIKU_USD_PER_MTOK_INPUT +
    (estimatedOutputTokens / 1_000_000) * HAIKU_USD_PER_MTOK_OUTPUT;

  return {
    source: expandHomePath(source),
    includeSubagents,
    sessions,
    totals: {
      sessions: sessions.length,
      parseFailures: sessions.reduce((n, s) => n + s.parseFailures, 0),
      estimatedObservations,
      estimatedSummaries,
      estimatedHaikuCalls,
      contentBytes,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    },
  };
}

/** Render a dry-run report as human-readable lines for the CLI. */
export function formatDryRunReport(report: DryRunReport): string {
  const lines: string[] = [];
  lines.push(`Dry-run (no Haiku spend) — source: ${report.source}`);
  lines.push(`Subagents: ${report.includeSubagents ? 'included' : 'excluded'}`);
  lines.push('');
  for (const s of report.sessions) {
    const tag = s.isSubagent ? `  subagent${s.agentType ? ` (${s.agentType})` : ''}` : 'session';
    lines.push(
      `${tag} ${s.sessionId}: ${s.toolUses} obs, ${s.userPrompts} prompts, ` +
        `${s.assistantTexts} replies, ${s.toolResults} results, ${s.lines} lines` +
        (s.parseFailures ? `, ${s.parseFailures} parse-failures` : '')
    );
  }
  lines.push('');
  const t = report.totals;
  const mTokIn = (t.estimatedInputTokens / 1_000_000).toFixed(2);
  const mTokOut = (t.estimatedOutputTokens / 1_000_000).toFixed(2);
  lines.push(
    `TOTAL: ${t.sessions} sessions → ~${t.estimatedObservations} observations + ` +
      `~${t.estimatedSummaries} summaries = ~${t.estimatedHaikuCalls} Haiku calls` +
      (t.parseFailures ? ` (${t.parseFailures} parse-failures)` : '')
  );
  lines.push(
    `TOKENS (est): ~${mTokIn}M input + ~${mTokOut}M output ` +
      `(from ${(t.contentBytes / 1_000_000).toFixed(2)} MB content + ${PROMPT_OVERHEAD_TOKENS}tok/call overhead)`
  );
  lines.push(
    `COST (est): ~$${t.estimatedCostUsd.toFixed(2)} ` +
      `at Haiku $${HAIKU_USD_PER_MTOK_INPUT}/$${HAIKU_USD_PER_MTOK_OUTPUT} per Mtok in/out`
  );
  lines.push(
    'NOTE: input is a floor — the generator may prepend per-session history. ' +
      'If Haiku runs on subscription budget, the $ figure is not metered.'
  );
  return lines.join('\n');
}
