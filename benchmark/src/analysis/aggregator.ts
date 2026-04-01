import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTranscriptTokens, estimateCost } from '../judge/state-reader.js';
import type { TokenUsage } from '../judge/state-reader.js';
import type { SmokeResults } from '../eval/smoke-runner.js';
import type { JudgeResult } from '../eval/llm-judge.js';
import type { Prompt } from '../types.js';

// --- Error Classes ---

export class AggregationError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
  ) {
    super(`Aggregation failed for agent ${agentId}: ${reason}`);
    this.name = 'AggregationError';
  }
}

export class ResultsNotFoundError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly missingFile: string,
  ) {
    super(`Results not found for agent ${agentId}: ${missingFile}`);
    this.name = 'ResultsNotFoundError';
  }
}

// --- Interfaces ---

export interface AgentResult {
  schema_version: string;
  agent_id: string;
  arm: string;
  prompt_id: string;
  prompt_category: string;
  model_version: string;
  tokens: {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
    total: number;
  };
  cost_usd: number;
  wall_clock_seconds: number;
  completion_status: string;
  smoke_tests: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    results: Array<{ name: string; passed: boolean; actual: string }>;
  };
  rubric_scores: {
    functionality: number;
    code_quality: number;
    ux: number;
    completeness: number;
  };
  judge_blinded: boolean;
  industry_baseline: {
    source: string;
    reference_cost_usd: number | null;
    reference_duration_seconds: number | null;
    reference_architecture: string | null;
  };
  raw_log_sha256: string;
}

export interface SummaryStats {
  mean: number;
  median: number;
  p95: number;
  stdDev: number;
}

export interface ArmSummary {
  arm: string;
  agentCount: number;
  tokens: SummaryStats;
  costUsd: SummaryStats;
  wallClockSeconds: SummaryStats;
  rubricFunctionality: SummaryStats;
  rubricCodeQuality: SummaryStats;
  rubricUx: SummaryStats;
  rubricCompleteness: SummaryStats;
  smokePassRate: number;
}

export interface PromptSummary {
  promptId: string;
  promptCategory: string;
  agentCount: number;
  meanCostUsd: number;
  meanWallClockSeconds: number;
  meanFunctionality: number;
  meanCompleteness: number;
  smokePassRate: number;
}

export interface CategorySummary {
  category: string;
  agentCount: number;
  meanCostUsd: number;
  meanWallClockSeconds: number;
  meanFunctionality: number;
  smokePassRate: number;
}

export interface Summary {
  totalAgents: number;
  completionRate: number;
  perArm: ArmSummary[];
  perPrompt: PromptSummary[];
  perCategory: CategorySummary[];
}

// --- Helpers ---

function computeStats(values: number[]): SummaryStats {
  if (values.length === 0) {
    return { mean: 0, median: 0, p95: 0, stdDev: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  const p95 = sorted[Math.max(0, p95Index)];
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  return { mean, median, p95, stdDev };
}

function computeSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function determineCompletionStatus(agentDir: string, files: string[]): string {
  if (files.includes('DONE.md')) return 'DONE';
  if (files.includes('CRASHED.md')) return 'CRASHED';
  if (files.includes('KILLED.md')) return 'KILLED';
  return 'INCOMPLETE';
}

function extractWallClockSeconds(metadata: Record<string, unknown> | null): number {
  if (!metadata) return 0;
  if (typeof metadata.wall_clock_seconds === 'number') {
    return metadata.wall_clock_seconds;
  }
  if (typeof metadata.start_time === 'string' && typeof metadata.end_time === 'string') {
    const start = new Date(metadata.start_time).getTime();
    const end = new Date(metadata.end_time).getTime();
    if (!isNaN(start) && !isNaN(end)) {
      return Math.round((end - start) / 1000);
    }
  }
  return 0;
}

function extractArm(agentId: string, metadata: Record<string, unknown> | null): string {
  if (metadata && typeof metadata.arm === 'string') {
    return metadata.arm;
  }
  if (agentId.startsWith('cmem-')) return 'claude-mem';
  if (agentId.startsWith('vanilla-')) return 'vanilla';
  return 'vanilla';
}

// --- Public API ---

/**
 * Aggregates results for a single agent into the publishable schema format.
 */
export async function aggregateAgent(
  agentId: string,
  resultsDir: string,
  prompt: Prompt,
  modelVersion: string,
): Promise<AgentResult> {
  const agentDir = join(resultsDir, agentId);

  // Read directory contents for status detection
  let agentFiles: string[];
  try {
    agentFiles = await readdir(agentDir);
  } catch (error) {
    throw new ResultsNotFoundError(agentId, agentDir);
  }

  // Read all data sources in parallel
  const [smokeResults, judgeResult, tokenUsage, metadata, transcriptRaw] =
    await Promise.all([
      readJsonFile<SmokeResults>(join(agentDir, 'smoke-results.json')),
      readJsonFile<JudgeResult>(join(agentDir, 'judge-scores.json')),
      parseTranscriptTokens(join(agentDir, 'transcript.jsonl')),
      readJsonFile<Record<string, unknown>>(join(agentDir, 'metadata.json')),
      readFile(join(agentDir, 'transcript.jsonl'), 'utf-8').catch(() => ''),
    ]);

  const arm = extractArm(agentId, metadata);
  const completionStatus = determineCompletionStatus(agentDir, agentFiles);
  const wallClockSeconds = extractWallClockSeconds(metadata);
  const rawLogSha256 = transcriptRaw ? computeSha256(transcriptRaw) : computeSha256('');

  const tokens = tokenUsage
    ? {
        input: tokenUsage.inputTokens,
        output: tokenUsage.outputTokens,
        cache_creation: tokenUsage.cacheCreationTokens,
        cache_read: tokenUsage.cacheReadTokens,
        total: tokenUsage.totalTokens,
      }
    : { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0 };

  const costUsd = tokenUsage ? estimateCost(tokenUsage, modelVersion) : 0;

  const smokeTestsOutput = smokeResults
    ? {
        total: smokeResults.total,
        passed: smokeResults.passed,
        failed: smokeResults.failed,
        skipped: smokeResults.skipped,
        results: smokeResults.results.map((r) => ({
          name: r.name,
          passed: r.passed,
          actual: r.actual,
        })),
      }
    : { total: 0, passed: 0, failed: 0, skipped: 0, results: [] };

  const rubricScores = judgeResult
    ? {
        functionality: judgeResult.scores.functionality,
        code_quality: judgeResult.scores.code_quality,
        ux: judgeResult.scores.ux,
        completeness: judgeResult.scores.completeness,
      }
    : { functionality: 1, code_quality: 1, ux: 1, completeness: 1 };

  const judgeBlinded = judgeResult?.blinded ?? false;

  const industryBaseline = {
    source: prompt.frontmatter.industry_baseline.source,
    reference_cost_usd: prompt.frontmatter.industry_baseline.reference_cost_usd,
    reference_duration_seconds:
      prompt.frontmatter.industry_baseline.reference_duration_seconds,
    reference_architecture:
      prompt.frontmatter.industry_baseline.reference_architecture,
  };

  return {
    schema_version: '1.0',
    agent_id: agentId,
    arm,
    prompt_id: prompt.frontmatter.id,
    prompt_category: prompt.frontmatter.category,
    model_version: modelVersion,
    tokens,
    cost_usd: costUsd,
    wall_clock_seconds: wallClockSeconds,
    completion_status: completionStatus,
    smoke_tests: smokeTestsOutput,
    rubric_scores: rubricScores,
    judge_blinded: judgeBlinded,
    industry_baseline: industryBaseline,
    raw_log_sha256: rawLogSha256,
  };
}

/**
 * Aggregates results for all agents, matching each agent directory
 * to its corresponding prompt.
 */
export async function aggregateAll(
  resultsDir: string,
  prompts: Prompt[],
  modelVersion: string,
): Promise<AgentResult[]> {
  let agentDirs: string[];
  try {
    agentDirs = await readdir(resultsDir);
  } catch {
    return [];
  }

  const promptsByIdMap = new Map<string, Prompt>();
  for (const prompt of prompts) {
    promptsByIdMap.set(prompt.frontmatter.id, prompt);
  }

  const results: AgentResult[] = [];

  for (const agentId of agentDirs) {
    // Extract prompt ID from agent ID: e.g., "cmem-07-2" → "07"
    // Or look it up from metadata
    let prompt: Prompt | undefined;

    // Try reading metadata to find prompt_id
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(resultsDir, agentId, 'metadata.json'),
    );
    if (metadata && typeof metadata.prompt_id === 'string') {
      prompt = promptsByIdMap.get(metadata.prompt_id);
    }

    // Fallback: extract from agent ID pattern (e.g., cmem-07-2 or vanilla-07-1)
    if (!prompt) {
      const idMatch = agentId.match(/(?:cmem|vanilla)-(\d{2})/);
      if (idMatch) {
        const promptIdPrefix = idMatch[1];
        prompt = prompts.find((p) => p.frontmatter.id.startsWith(promptIdPrefix));
      }
    }

    if (!prompt) {
      // Skip agents without matching prompts
      continue;
    }

    try {
      const result = await aggregateAgent(agentId, resultsDir, prompt, modelVersion);
      results.push(result);
    } catch (error) {
      if (error instanceof ResultsNotFoundError) {
        // Skip agents whose results directory is missing or not a directory
        continue;
      }
      throw new AggregationError(
        agentId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return results;
}

/**
 * Generates summary statistics across all results, broken down
 * by arm, prompt, and category.
 */
export function generateSummary(results: AgentResult[]): Summary {
  const totalAgents = results.length;
  const completedAgents = results.filter(
    (r) => r.completion_status === 'DONE',
  ).length;
  const completionRate = totalAgents > 0 ? completedAgents / totalAgents : 0;

  // Per-arm summaries
  const armGroups = new Map<string, AgentResult[]>();
  for (const result of results) {
    const group = armGroups.get(result.arm) ?? [];
    group.push(result);
    armGroups.set(result.arm, group);
  }

  const perArm: ArmSummary[] = [];
  for (const [arm, armResults] of armGroups) {
    const totalSmoke = armResults.reduce(
      (sum, r) => sum + r.smoke_tests.total,
      0,
    );
    const passedSmoke = armResults.reduce(
      (sum, r) => sum + r.smoke_tests.passed,
      0,
    );

    perArm.push({
      arm,
      agentCount: armResults.length,
      tokens: computeStats(armResults.map((r) => r.tokens.total)),
      costUsd: computeStats(armResults.map((r) => r.cost_usd)),
      wallClockSeconds: computeStats(
        armResults.map((r) => r.wall_clock_seconds),
      ),
      rubricFunctionality: computeStats(
        armResults.map((r) => r.rubric_scores.functionality),
      ),
      rubricCodeQuality: computeStats(
        armResults.map((r) => r.rubric_scores.code_quality),
      ),
      rubricUx: computeStats(armResults.map((r) => r.rubric_scores.ux)),
      rubricCompleteness: computeStats(
        armResults.map((r) => r.rubric_scores.completeness),
      ),
      smokePassRate: totalSmoke > 0 ? passedSmoke / totalSmoke : 0,
    });
  }

  // Per-prompt summaries
  const promptGroups = new Map<string, AgentResult[]>();
  for (const result of results) {
    const group = promptGroups.get(result.prompt_id) ?? [];
    group.push(result);
    promptGroups.set(result.prompt_id, group);
  }

  const perPrompt: PromptSummary[] = [];
  for (const [promptId, promptResults] of promptGroups) {
    const totalSmoke = promptResults.reduce(
      (sum, r) => sum + r.smoke_tests.total,
      0,
    );
    const passedSmoke = promptResults.reduce(
      (sum, r) => sum + r.smoke_tests.passed,
      0,
    );

    perPrompt.push({
      promptId,
      promptCategory: promptResults[0].prompt_category,
      agentCount: promptResults.length,
      meanCostUsd:
        promptResults.reduce((sum, r) => sum + r.cost_usd, 0) /
        promptResults.length,
      meanWallClockSeconds:
        promptResults.reduce((sum, r) => sum + r.wall_clock_seconds, 0) /
        promptResults.length,
      meanFunctionality:
        promptResults.reduce(
          (sum, r) => sum + r.rubric_scores.functionality,
          0,
        ) / promptResults.length,
      meanCompleteness:
        promptResults.reduce(
          (sum, r) => sum + r.rubric_scores.completeness,
          0,
        ) / promptResults.length,
      smokePassRate: totalSmoke > 0 ? passedSmoke / totalSmoke : 0,
    });
  }

  // Per-category summaries
  const categoryGroups = new Map<string, AgentResult[]>();
  for (const result of results) {
    const group = categoryGroups.get(result.prompt_category) ?? [];
    group.push(result);
    categoryGroups.set(result.prompt_category, group);
  }

  const perCategory: CategorySummary[] = [];
  for (const [category, categoryResults] of categoryGroups) {
    const totalSmoke = categoryResults.reduce(
      (sum, r) => sum + r.smoke_tests.total,
      0,
    );
    const passedSmoke = categoryResults.reduce(
      (sum, r) => sum + r.smoke_tests.passed,
      0,
    );

    perCategory.push({
      category,
      agentCount: categoryResults.length,
      meanCostUsd:
        categoryResults.reduce((sum, r) => sum + r.cost_usd, 0) /
        categoryResults.length,
      meanWallClockSeconds:
        categoryResults.reduce((sum, r) => sum + r.wall_clock_seconds, 0) /
        categoryResults.length,
      meanFunctionality:
        categoryResults.reduce(
          (sum, r) => sum + r.rubric_scores.functionality,
          0,
        ) / categoryResults.length,
      smokePassRate: totalSmoke > 0 ? passedSmoke / totalSmoke : 0,
    });
  }

  return {
    totalAgents,
    completionRate,
    perArm,
    perPrompt,
    perCategory,
  };
}

/**
 * Validates an AgentResult against the JSON schema at the given path.
 */
export async function validateAgainstSchema(
  result: AgentResult,
  schemaPath: string,
): Promise<boolean> {
  const schemaContent = await readFile(schemaPath, 'utf-8');
  const schema = JSON.parse(schemaContent) as Record<string, unknown>;

  // Validate required fields
  const requiredFields = schema.required as string[] | undefined;
  if (requiredFields) {
    for (const field of requiredFields) {
      if (!(field in result)) {
        return false;
      }
    }
  }

  // Validate property types and constraints
  const properties = schema.properties as Record<
    string,
    Record<string, unknown>
  > | undefined;
  if (!properties) return true;

  const resultRecord = result as unknown as Record<string, unknown>;

  for (const [propName, propSchema] of Object.entries(properties)) {
    const value = resultRecord[propName];
    if (value === undefined) continue;

    // Check const values
    if ('const' in propSchema && value !== propSchema.const) {
      return false;
    }

    // Check enum values
    if ('enum' in propSchema) {
      const enumValues = propSchema.enum as unknown[];
      if (!enumValues.includes(value)) {
        return false;
      }
    }

    // Check string patterns
    if (propSchema.type === 'string' && typeof value === 'string' && propSchema.pattern) {
      const regex = new RegExp(propSchema.pattern as string);
      if (!regex.test(value)) {
        return false;
      }
    }

    // Check numeric constraints
    if (
      (propSchema.type === 'number' || propSchema.type === 'integer') &&
      typeof value === 'number'
    ) {
      if ('minimum' in propSchema && value < (propSchema.minimum as number)) {
        return false;
      }
      if ('maximum' in propSchema && value > (propSchema.maximum as number)) {
        return false;
      }
    }
  }

  // Check additionalProperties: false
  if (schema.additionalProperties === false) {
    const allowedKeys = new Set(Object.keys(properties));
    for (const key of Object.keys(resultRecord)) {
      if (!allowedKeys.has(key)) {
        return false;
      }
    }
  }

  return true;
}
