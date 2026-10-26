/**
 * Token Savings for the install funnel: how many tokens each coding agent on
 * this machine used in the scan window, read from the agents' own transcripts
 * (read-only, during the setup scan). Formats, as found in real files:
 *
 * - Claude Code: assistant lines carry `message.usage`. One API message is
 *   written once per content block with the same `message.id`, so each id
 *   counts once. Tokens = input + cache creation + cache read + output.
 *   claude-mem's own observer sessions (OBSERVER_SESSIONS_DIR) are not the
 *   person's usage and are left out.
 * - Codex: `event_msg` lines with `payload.type: "token_count"` carry the
 *   session's running `info.total_token_usage.total_tokens` (input, which
 *   includes cached input, plus output). The same total is often repeated, so
 *   a session's usage is the sum of its increases.
 * - Gemini CLI: `gemini` messages carry `tokens.total` (input incl. cached,
 *   output, thoughts, tool).
 * - OpenCode: assistant messages carry `tokens` {input, output, reasoning,
 *   cache: {read, write}}.
 * - Antigravity CLI: its history file holds only typed prompts, and its
 *   conversations are binary protobuf records; no readable token counts.
 *
 * The persona needs a complete window (DATA-CONTRACT.md, revision 09): the
 * person's agent history starts at or before the window start, and no agent
 * deletes transcripts sooner than the window (Claude Code `cleanupPeriodDays`).
 * The efficiency percent comes only from claude-mem's own observations,
 * through calculateTokenEconomics; with no observations it is omitted.
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { OBSERVER_SESSIONS_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { calculateTokenEconomics, combineTokenEconomics, type ObservationTokenFields } from '../context/TokenCalculator.js';
import type { TokenEconomics } from '../context/types.js';
import { PROMPT_SCAN_WINDOW_DAYS } from './index.js';
import { createPromptReaders, isoToEpochMs, parseLine, readGeminiChat, readLines, type PromptAgentId, type TranscriptSource } from './readers.js';

export type UsageCoverage = 'complete' | 'partial' | 'none';
export type UsagePersona = 'Cracked Dev' | 'Heavy AI User' | 'Medium AI User' | 'Light AI User';

/** DATA-CONTRACT.md (revision 09): complete-30-day whole-agent thresholds, lowest first. */
export const USAGE_PERSONA_THRESHOLDS: Array<{ persona: UsagePersona; minTokens: number }> = [
  { persona: 'Light AI User', minTokens: 0 },
  { persona: 'Medium AI User', minTokens: 10_000_000 },
  { persona: 'Heavy AI User', minTokens: 50_000_000 },
  { persona: 'Cracked Dev', minTokens: 150_000_000 },
];

export function personaFor(tokens: number): UsagePersona {
  return USAGE_PERSONA_THRESHOLDS.filter(threshold => tokens >= threshold.minTokens).at(-1)!.persona;
}

export interface AgentTokenUsage {
  id: PromptAgentId;
  label: string;
  detected: boolean;
  /** False when the agent's transcripts carry no token counts (Antigravity CLI). */
  recordsTokens: boolean;
  /** Tokens used inside the window. */
  tokens: number;
  /** The agent's records reach back to the window start (older transcripts exist, or a record at or before it). */
  historyStartsBeforeWindow: boolean;
  /** The earliest token record read (files changed inside the window). */
  firstRecordAt: string | null;
  /** The agent deletes transcripts sooner than the window lasts. */
  retentionShorterThanWindow: boolean;
  skippedSources: number;
}

export interface SetupTokenUsage {
  windowStart: string;
  windowDays: number;
  agents: AgentTokenUsage[];
  /** Tokens of every agent that records them. */
  totalTokens: number;
  coverage: UsageCoverage;
  /** Only for a complete window. */
  persona: UsagePersona | null;
  /** calculateTokenEconomics().savingsPercent over claude-mem's observations; null without observation history. */
  efficiencyPercent: number | null;
  observations: number;
}

export interface TokenUsageScanOptions {
  sinceEpochMs: number;
  windowDays?: number;
  homeDirectory?: string;
  agents?: PromptAgentId[];
  /** Claude Code working directories whose sessions are not the person's (default: claude-mem's observer sessions). */
  excludedClaudeCwds?: string[];
}

interface UsageTally {
  tokens: number;
  firstRecordAt: number | null;
}

function tally(usage: UsageTally, at: number | null, tokens: number, sinceEpochMs: number): void {
  if (at === null) return;
  if (usage.firstRecordAt === null || at < usage.firstRecordAt) usage.firstRecordAt = at;
  if (at >= sinceEpochMs && tokens > 0) usage.tokens += tokens;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Claude Code's project folder name for a working directory. */
const claudeProjectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function claudeRetentionDays(homeDirectory: string): number {
  try {
    const days = JSON.parse(readFileSync(join(homeDirectory, '.claude', 'settings.json'), 'utf8')).cleanupPeriodDays;
    return typeof days === 'number' ? days : 30;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('IMPORT', 'Could not read ~/.claude/settings.json', { error: String(error) });
    return 30;
  }
}

interface UsageReader {
  read(sources: TranscriptSource[], sinceEpochMs: number, usage: UsageTally, skip: (source: TranscriptSource, error: unknown) => void): Promise<void>;
  retentionDays?(homeDirectory: string): number;
}

function claudeCodeUsage(excludedFolders: Set<string>): UsageReader {
  return {
    retentionDays: claudeRetentionDays,
    async read(sources, sinceEpochMs, usage, skip) {
      const seenMessages = new Set<string>();
      for (const source of sources) {
        const projectFolder = basename(source.holdsPrompts ? dirname(source.path) : dirname(dirname(dirname(source.path))));
        if (excludedFolders.has(projectFolder)) continue;
        try {
          for await (const line of readLines(source.path)) {
            if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) continue;
            const record = parseLine(line);
            const message = record?.message;
            if (record?.type !== 'assistant' || !message?.usage) continue;
            const key = typeof message.id === 'string' && message.id ? message.id : `${record.requestId ?? ''}\u0000${record.uuid ?? ''}`;
            if (seenMessages.has(key)) continue;
            seenMessages.add(key);
            const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = message.usage;
            tally(usage, isoToEpochMs(record.timestamp), count(input_tokens) + count(cache_creation_input_tokens) + count(cache_read_input_tokens) + count(output_tokens), sinceEpochMs);
          }
        } catch (error) { skip(source, error); }
      }
    },
  };
}

const codexUsage: UsageReader = {
  async read(sources, sinceEpochMs, usage, skip) {
    for (const source of sources) {
      try {
        let previousTotal: number | null = null;
        for await (const line of readLines(source.path)) {
          if (!line.includes('"token_count"')) continue;
          const record = parseLine(line);
          const info = record?.payload?.type === 'token_count' ? record.payload.info : null;
          const total = info?.total_token_usage?.total_tokens;
          if (record?.type !== 'event_msg' || typeof total !== 'number') continue;
          // The first count in a file may continue an earlier session's running total; only its own turn is new.
          const increase = previousTotal === null ? count(info.last_token_usage?.total_tokens) : Math.max(0, total - previousTotal);
          previousTotal = total;
          tally(usage, isoToEpochMs(record.timestamp), increase, sinceEpochMs);
        }
      } catch (error) { skip(source, error); }
    }
  },
};

const geminiCliUsage: UsageReader = {
  async read(sources, sinceEpochMs, usage, skip) {
    const seenMessages = new Set<string>();
    for (const source of sources) {
      try {
        const { messages } = await readGeminiChat(source.path);
        for (const message of messages) {
          if (message?.type !== 'gemini' || !message.tokens) continue;
          const key = typeof message.id === 'string' && message.id ? message.id : `${source.path}\u0000${message.timestamp}`;
          if (seenMessages.has(key)) continue;
          seenMessages.add(key);
          const { total, input, output, thoughts, tool } = message.tokens;
          tally(usage, isoToEpochMs(message.timestamp), typeof total === 'number' ? count(total) : count(input) + count(output) + count(thoughts) + count(tool), sinceEpochMs);
        }
      } catch (error) { skip(source, error); }
    }
  },
};

const openCodeUsage: UsageReader = {
  async read(sources, sinceEpochMs, usage, skip) {
    for (const source of sources) {
      try {
        const database = new Database(source.path, { readonly: true });
        try {
          const rows = database.prepare(`SELECT time_created AS createdAt, json_extract(data, '$.tokens') AS tokens
            FROM message WHERE json_extract(data, '$.role') = 'assistant'`).all() as Array<{ createdAt: number; tokens: string | null }>;
          for (const row of rows) {
            const tokens = row.tokens ? parseLine(row.tokens) : null;
            if (!tokens) continue;
            tally(usage, row.createdAt, count(tokens.input) + count(tokens.output) + count(tokens.reasoning) + count(tokens.cache?.read) + count(tokens.cache?.write), sinceEpochMs);
          }
        } finally {
          database.close();
        }
      } catch (error) { skip(source, error); }
    }
  },
};

/** Reads each agent's token counts for the window. Read-only; an unreadable file is skipped, logged and counted. */
export async function scanTokenUsage(options: TokenUsageScanOptions): Promise<{ windowStart: string; windowDays: number; agents: AgentTokenUsage[] }> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const windowDays = options.windowDays ?? PROMPT_SCAN_WINDOW_DAYS;
  const excludedFolders = new Set((options.excludedClaudeCwds ?? [OBSERVER_SESSIONS_DIR]).map(claudeProjectFolder));
  const usageReaders: Partial<Record<PromptAgentId, UsageReader>> = {
    'claude-code': claudeCodeUsage(excludedFolders), codex: codexUsage, 'gemini-cli': geminiCliUsage, opencode: openCodeUsage,
  };
  const agents: AgentTokenUsage[] = [];
  for (const reader of createPromptReaders().filter(entry => !options.agents || options.agents.includes(entry.id))) {
    const { detected, sources } = reader.locate(homeDirectory);
    const usageReader = usageReaders[reader.id];
    const usage: UsageTally = { tokens: 0, firstRecordAt: null };
    let skippedSources = 0;
    if (usageReader) {
      await usageReader.read(sources.filter(source => source.mtimeMs >= options.sinceEpochMs), options.sinceEpochMs, usage, (source, error) => {
        skippedSources++;
        logger.warn('IMPORT', 'Skipped an unreadable transcript while counting tokens', { path: source.path, reason: error instanceof Error ? error.message : String(error) });
      });
    }
    const olderSources = sources.some(source => source.mtimeMs < options.sinceEpochMs);
    agents.push({
      id: reader.id, label: reader.label, detected, recordsTokens: !!usageReader, tokens: usage.tokens,
      historyStartsBeforeWindow: !!usageReader && (olderSources || (usage.firstRecordAt !== null && usage.firstRecordAt <= options.sinceEpochMs)),
      firstRecordAt: usage.firstRecordAt === null ? null : new Date(usage.firstRecordAt).toISOString(),
      retentionShorterThanWindow: (usageReader?.retentionDays?.(homeDirectory) ?? Infinity) < windowDays,
      skippedSources,
    });
  }
  return { windowStart: new Date(options.sinceEpochMs).toISOString(), windowDays, agents };
}

/** calculateTokenEconomics over every observation, in batches so the whole history is never held at once. */
export function observationTokenEconomics(rows: Iterable<ObservationTokenFields>, batchSize = 1000): TokenEconomics {
  const parts: TokenEconomics[] = [];
  let batch: ObservationTokenFields[] = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length === batchSize) { parts.push(calculateTokenEconomics(batch)); batch = []; }
  }
  parts.push(calculateTokenEconomics(batch));
  return combineTokenEconomics(parts);
}

/** The Token Savings result: total, coverage, and persona and percent only where the data supports them. */
export function summarizeTokenUsage(
  scan: { windowStart: string; windowDays: number; agents: AgentTokenUsage[] },
  economics: TokenEconomics | null,
): SetupTokenUsage {
  const measured = scan.agents.filter(agent => agent.detected && agent.recordsTokens);
  const totalTokens = measured.reduce((sum, agent) => sum + agent.tokens, 0);
  const shortRetention = measured.some(agent => agent.retentionShorterThanWindow && agent.firstRecordAt !== null);
  const coverage: UsageCoverage = totalTokens === 0 ? 'none'
    : !shortRetention && scan.windowDays === PROMPT_SCAN_WINDOW_DAYS && measured.some(agent => agent.historyStartsBeforeWindow) ? 'complete'
      : 'partial';
  const hasHistory = !!economics && economics.totalObservations > 0 && economics.totalDiscoveryTokens > 0 && economics.savingsPercent > 0;
  return {
    ...scan,
    totalTokens,
    coverage,
    persona: coverage === 'complete' ? personaFor(totalTokens) : null,
    efficiencyPercent: hasHistory ? economics!.savingsPercent : null,
    observations: economics?.totalObservations ?? 0,
  };
}
