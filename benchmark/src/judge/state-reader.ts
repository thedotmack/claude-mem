import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// --- Error Classes ---

export class StateReadError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
  ) {
    super(`Failed to read state for agent ${agentId}: ${reason}`);
    this.name = 'StateReadError';
  }
}

export class TranscriptParseError extends Error {
  constructor(
    public readonly transcriptPath: string,
    public readonly reason: string,
  ) {
    super(`Failed to parse transcript at ${transcriptPath}: ${reason}`);
    this.name = 'TranscriptParseError';
  }
}

// --- Interfaces ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface AgentState {
  agentId: string;
  containerStatus: string;
  isDone: boolean;
  isCrashed: boolean;
  isKilled: boolean;
  lastActivityTime: Date | null;
  fileCount: number;
  elapsedSeconds: number;
  tokenUsage: TokenUsage | null;
  estimatedCostUsd: number;
}

// --- Pricing (Claude Opus 4.6) ---

const PRICING_PER_MILLION = {
  input: 15,
  output: 75,
  cacheCreation: 18.75,
  cacheRead: 1.875,
} as const;

/**
 * Estimates cost in USD based on Anthropic Claude Opus 4.6 pricing.
 */
export function estimateCost(usage: TokenUsage, _model: string): number {
  const inputCost = (usage.inputTokens / 1_000_000) * PRICING_PER_MILLION.input;
  const outputCost = (usage.outputTokens / 1_000_000) * PRICING_PER_MILLION.output;
  const cacheCreationCost =
    (usage.cacheCreationTokens / 1_000_000) * PRICING_PER_MILLION.cacheCreation;
  const cacheReadCost =
    (usage.cacheReadTokens / 1_000_000) * PRICING_PER_MILLION.cacheRead;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

/**
 * Parses a transcript.jsonl file and sums token usage across all assistant entries.
 *
 * Each JSONL line may contain:
 * {"type":"assistant","message":{"usage":{"input_tokens":N,"output_tokens":N,"cache_creation_input_tokens":N,"cache_read_input_tokens":N}}}
 */
export async function parseTranscriptTokens(
  transcriptPath: string,
): Promise<TokenUsage | null> {
  let content: string;
  try {
    content = await readFile(transcriptPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new TranscriptParseError(
      transcriptPath,
      error instanceof Error ? error.message : String(error),
    );
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip malformed lines
      continue;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>).type !== 'assistant'
    ) {
      continue;
    }

    const message = (parsed as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) {
      continue;
    }

    const usage = (message as Record<string, unknown>).usage;
    if (typeof usage !== 'object' || usage === null) {
      continue;
    }

    const u = usage as Record<string, unknown>;
    inputTokens += typeof u.input_tokens === 'number' ? u.input_tokens : 0;
    outputTokens += typeof u.output_tokens === 'number' ? u.output_tokens : 0;
    cacheCreationTokens +=
      typeof u.cache_creation_input_tokens === 'number'
        ? u.cache_creation_input_tokens
        : 0;
    cacheReadTokens +=
      typeof u.cache_read_input_tokens === 'number'
        ? u.cache_read_input_tokens
        : 0;
  }

  const totalTokens =
    inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

  // If we found no usage at all, return null
  if (totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
  };
}

/**
 * Checks if a sentinel file exists in the agent's results directory.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the most recent file modification time in a directory (non-recursive).
 */
async function findLastActivityTime(dirPath: string): Promise<Date | null> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return null;
  }

  let latestTime: Date | null = null;

  for (const entry of entries) {
    try {
      const fileStat = await stat(join(dirPath, entry));
      if (latestTime === null || fileStat.mtime > latestTime) {
        latestTime = fileStat.mtime;
      }
    } catch {
      // Skip files we can't stat
      continue;
    }
  }

  return latestTime;
}

/**
 * Counts files in a directory (non-recursive).
 */
async function countFiles(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath);
    return entries.length;
  } catch {
    return 0;
  }
}

/**
 * Reads the full state of an agent from its results directory.
 */
export async function readAgentState(
  agentId: string,
  resultsDir: string,
  startTime: Date,
): Promise<AgentState> {
  const agentDir = join(resultsDir, agentId);

  try {
    const [isDone, isCrashed, isKilled, lastActivityTime, fileCount, tokenUsage] =
      await Promise.all([
        fileExists(join(agentDir, 'DONE.md')),
        fileExists(join(agentDir, 'CRASHED.md')),
        fileExists(join(agentDir, 'KILLED.md')),
        findLastActivityTime(agentDir),
        countFiles(agentDir),
        parseTranscriptTokens(join(agentDir, 'transcript.jsonl')),
      ]);

    const now = new Date();
    const elapsedSeconds = (now.getTime() - startTime.getTime()) / 1000;

    let containerStatus = 'running';
    if (isDone) containerStatus = 'exited';
    else if (isCrashed) containerStatus = 'dead';
    else if (isKilled) containerStatus = 'exited';

    const estimatedCostUsd = tokenUsage
      ? estimateCost(tokenUsage, 'claude-opus-4-6')
      : 0;

    return {
      agentId,
      containerStatus,
      isDone,
      isCrashed,
      isKilled,
      lastActivityTime,
      fileCount,
      elapsedSeconds,
      tokenUsage,
      estimatedCostUsd,
    };
  } catch (error) {
    throw new StateReadError(
      agentId,
      error instanceof Error ? error.message : String(error),
    );
  }
}
