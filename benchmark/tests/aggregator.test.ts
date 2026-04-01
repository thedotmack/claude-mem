import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import {
  aggregateAgent,
  aggregateAll,
  generateSummary,
  validateAgainstSchema,
  AggregationError,
  ResultsNotFoundError,
} from '../src/analysis/aggregator.js';
import type { AgentResult } from '../src/analysis/aggregator.js';
import type { Prompt } from '../src/types.js';
import type { SmokeResults } from '../src/eval/smoke-runner.js';
import type { JudgeResult } from '../src/eval/llm-judge.js';

const TEMP_DIR = join(import.meta.dir, '..', '.test-tmp-aggregator');
const SCHEMA_PATH = join(import.meta.dir, '..', 'schema', 'agent-result.schema.json');

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true });
}

async function cleanupTempDir(): Promise<void> {
  try {
    await rm(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function makeTestPrompt(overrides?: Partial<Prompt['frontmatter']>): Prompt {
  return {
    frontmatter: {
      id: '07-retro-forge',
      title: 'RetroForge Game',
      category: 'web',
      timeout_hint: '45m',
      industry_baseline: {
        source: 'anthropic',
        reference_cost_usd: 2.53,
        reference_duration_seconds: 1200,
        reference_architecture: '3-agent pipeline',
      },
      smoke_tests: [
        { name: 'server responds', command: 'curl localhost:3000', expected: 'status:200' },
      ],
      ...overrides,
    },
    body: 'Build a retro game.',
    filePath: '/tmp/prompts/07-retro-forge.md',
  };
}

function makeTestSmokeResults(): SmokeResults {
  return {
    agentId: 'cmem-07-1',
    promptId: '07-retro-forge',
    total: 3,
    passed: 2,
    failed: 1,
    skipped: 0,
    results: [
      { name: 'server responds', command: 'curl localhost:3000', expected: 'status:200', passed: true, actual: 'stdout=200' },
      { name: 'has game board', command: 'curl localhost:3000', expected: 'contains:canvas', passed: true, actual: 'stdout=<canvas>' },
      { name: 'has score', command: 'curl localhost:3000', expected: 'contains:score', passed: false, actual: 'stdout=no match' },
    ],
  };
}

function makeTestJudgeResult(): JudgeResult {
  return {
    agentId: 'cmem-07-1',
    promptId: '07-retro-forge',
    scores: {
      functionality: 7,
      code_quality: 6,
      ux: 5,
      completeness: 7,
      reasoning: {
        functionality: 'Good implementation.',
        code_quality: 'Clean code.',
        ux: 'Decent UX.',
        completeness: 'Mostly complete.',
      },
    },
    blinded: true,
    judgeModel: 'claude-opus-4-6',
    timestamp: '2026-03-31T12:00:00Z',
  };
}

async function setupAgentFixture(
  agentId: string,
  options?: {
    includeSmoke?: boolean;
    includeJudge?: boolean;
    includeTranscript?: boolean;
    includeMetadata?: boolean;
    includeDone?: boolean;
  },
): Promise<void> {
  const opts = {
    includeSmoke: true,
    includeJudge: true,
    includeTranscript: true,
    includeMetadata: true,
    includeDone: true,
    ...options,
  };

  const agentDir = join(TEMP_DIR, agentId);
  await mkdir(agentDir, { recursive: true });

  if (opts.includeSmoke) {
    await writeFile(
      join(agentDir, 'smoke-results.json'),
      JSON.stringify(makeTestSmokeResults()),
    );
  }

  if (opts.includeJudge) {
    await writeFile(
      join(agentDir, 'judge-scores.json'),
      JSON.stringify(makeTestJudgeResult()),
    );
  }

  if (opts.includeTranscript) {
    const transcriptLines = [
      '{"type":"assistant","message":{"usage":{"input_tokens":5000,"output_tokens":2000,"cache_creation_input_tokens":1000,"cache_read_input_tokens":500}}}',
      '{"type":"user","message":{}}',
      '{"type":"assistant","message":{"usage":{"input_tokens":3000,"output_tokens":1500}}}',
    ];
    await writeFile(
      join(agentDir, 'transcript.jsonl'),
      transcriptLines.join('\n'),
    );
  }

  if (opts.includeMetadata) {
    await writeFile(
      join(agentDir, 'metadata.json'),
      JSON.stringify({
        agent_id: agentId,
        arm: agentId.startsWith('cmem') ? 'claude-mem' : 'vanilla',
        prompt_id: '07-retro-forge',
        wall_clock_seconds: 600,
        start_time: '2026-03-31T10:00:00Z',
        end_time: '2026-03-31T10:10:00Z',
      }),
    );
  }

  if (opts.includeDone) {
    await writeFile(join(agentDir, 'DONE.md'), '# Done');
  }
}

describe('aggregator', () => {
  beforeEach(async () => {
    await ensureTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  describe('aggregateAgent', () => {
    test('aggregates all data for a complete agent', async () => {
      await setupAgentFixture('cmem-07-1');
      const prompt = makeTestPrompt();

      const result = await aggregateAgent(
        'cmem-07-1',
        TEMP_DIR,
        prompt,
        'claude-opus-4-6',
      );

      expect(result.schema_version).toBe('1.0');
      expect(result.agent_id).toBe('cmem-07-1');
      expect(result.arm).toBe('claude-mem');
      expect(result.prompt_id).toBe('07-retro-forge');
      expect(result.prompt_category).toBe('web');
      expect(result.model_version).toBe('claude-opus-4-6');
      expect(result.completion_status).toBe('DONE');
      expect(result.wall_clock_seconds).toBe(600);

      // Token usage: 5000+3000 input, 2000+1500 output, 1000 cache create, 500 cache read
      expect(result.tokens.input).toBe(8000);
      expect(result.tokens.output).toBe(3500);
      expect(result.tokens.cache_creation).toBe(1000);
      expect(result.tokens.cache_read).toBe(500);
      expect(result.tokens.total).toBe(13000);

      expect(result.cost_usd).toBeGreaterThan(0);

      // Smoke tests
      expect(result.smoke_tests.total).toBe(3);
      expect(result.smoke_tests.passed).toBe(2);
      expect(result.smoke_tests.failed).toBe(1);
      expect(result.smoke_tests.results).toHaveLength(3);

      // Rubric scores
      expect(result.rubric_scores.functionality).toBe(7);
      expect(result.rubric_scores.code_quality).toBe(6);
      expect(result.rubric_scores.ux).toBe(5);
      expect(result.rubric_scores.completeness).toBe(7);

      expect(result.judge_blinded).toBe(true);

      // Industry baseline
      expect(result.industry_baseline.source).toBe('anthropic');
      expect(result.industry_baseline.reference_cost_usd).toBe(2.53);

      // SHA-256 hash
      expect(result.raw_log_sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    test('handles missing smoke-results.json gracefully', async () => {
      await setupAgentFixture('cmem-07-1', { includeSmoke: false });
      const prompt = makeTestPrompt();

      const result = await aggregateAgent(
        'cmem-07-1',
        TEMP_DIR,
        prompt,
        'claude-opus-4-6',
      );

      expect(result.smoke_tests.total).toBe(0);
      expect(result.smoke_tests.passed).toBe(0);
      expect(result.smoke_tests.results).toHaveLength(0);
    });

    test('handles missing judge-scores.json gracefully', async () => {
      await setupAgentFixture('cmem-07-1', { includeJudge: false });
      const prompt = makeTestPrompt();

      const result = await aggregateAgent(
        'cmem-07-1',
        TEMP_DIR,
        prompt,
        'claude-opus-4-6',
      );

      // Default scores when judge is missing
      expect(result.rubric_scores.functionality).toBe(1);
      expect(result.rubric_scores.code_quality).toBe(1);
      expect(result.rubric_scores.ux).toBe(1);
      expect(result.rubric_scores.completeness).toBe(1);
      expect(result.judge_blinded).toBe(false);
    });

    test('handles missing transcript.jsonl gracefully', async () => {
      await setupAgentFixture('cmem-07-1', { includeTranscript: false });
      const prompt = makeTestPrompt();

      const result = await aggregateAgent(
        'cmem-07-1',
        TEMP_DIR,
        prompt,
        'claude-opus-4-6',
      );

      expect(result.tokens.total).toBe(0);
      expect(result.cost_usd).toBe(0);
    });

    test('throws ResultsNotFoundError for non-existent agent directory', async () => {
      const prompt = makeTestPrompt();

      let thrown = false;
      try {
        await aggregateAgent(
          'nonexistent-agent',
          TEMP_DIR,
          prompt,
          'claude-opus-4-6',
        );
      } catch (error) {
        thrown = true;
        expect(error).toBeInstanceOf(ResultsNotFoundError);
      }
      expect(thrown).toBe(true);
    });

    test('detects CRASHED completion status', async () => {
      const agentDir = join(TEMP_DIR, 'cmem-07-crash');
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'CRASHED.md'), '# Crashed');
      await writeFile(join(agentDir, 'transcript.jsonl'), '');

      const prompt = makeTestPrompt();
      const result = await aggregateAgent(
        'cmem-07-crash',
        TEMP_DIR,
        prompt,
        'claude-opus-4-6',
      );

      expect(result.completion_status).toBe('CRASHED');
    });

    test('detects INCOMPLETE when no sentinel files present', async () => {
      const agentDir = join(TEMP_DIR, 'cmem-07-incomplete');
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'transcript.jsonl'), '');

      const prompt = makeTestPrompt();
      const result = await aggregateAgent(
        'cmem-07-incomplete',
        TEMP_DIR,
        prompt,
        'claude-opus-4-6',
      );

      expect(result.completion_status).toBe('INCOMPLETE');
    });
  });

  describe('aggregateAll', () => {
    test('aggregates multiple agents', async () => {
      await setupAgentFixture('cmem-07-1');
      await setupAgentFixture('vanilla-07-1');

      const prompts = [makeTestPrompt()];
      const results = await aggregateAll(TEMP_DIR, prompts, 'claude-opus-4-6');

      expect(results.length).toBe(2);
      const arms = results.map((r) => r.arm).sort();
      expect(arms).toEqual(['claude-mem', 'vanilla']);
    });

    test('returns empty array for non-existent results directory', async () => {
      const prompts = [makeTestPrompt()];
      const results = await aggregateAll(
        join(TEMP_DIR, 'nonexistent'),
        prompts,
        'claude-opus-4-6',
      );

      expect(results).toEqual([]);
    });
  });

  describe('generateSummary', () => {
    test('computes mean and median correctly', () => {
      const results: AgentResult[] = [
        makeAgentResult({ cost_usd: 1.0, arm: 'claude-mem' }),
        makeAgentResult({ cost_usd: 2.0, arm: 'claude-mem' }),
        makeAgentResult({ cost_usd: 3.0, arm: 'claude-mem' }),
        makeAgentResult({ cost_usd: 10.0, arm: 'claude-mem' }),
      ];

      const summary = generateSummary(results);

      const cmemArm = summary.perArm.find((a) => a.arm === 'claude-mem');
      expect(cmemArm).toBeDefined();
      // Mean: (1 + 2 + 3 + 10) / 4 = 4.0
      expect(cmemArm!.costUsd.mean).toBeCloseTo(4.0, 2);
      // Median of [1, 2, 3, 10] = (2 + 3) / 2 = 2.5
      expect(cmemArm!.costUsd.median).toBeCloseTo(2.5, 2);
    });

    test('computes per-arm stats separately', () => {
      const results: AgentResult[] = [
        makeAgentResult({ arm: 'claude-mem', cost_usd: 2.0 }),
        makeAgentResult({ arm: 'claude-mem', cost_usd: 4.0 }),
        makeAgentResult({ arm: 'vanilla', cost_usd: 3.0 }),
        makeAgentResult({ arm: 'vanilla', cost_usd: 5.0 }),
      ];

      const summary = generateSummary(results);

      expect(summary.perArm).toHaveLength(2);

      const cmem = summary.perArm.find((a) => a.arm === 'claude-mem');
      const vanilla = summary.perArm.find((a) => a.arm === 'vanilla');

      expect(cmem!.costUsd.mean).toBeCloseTo(3.0, 2);
      expect(vanilla!.costUsd.mean).toBeCloseTo(4.0, 2);
    });

    test('computes completion rate correctly', () => {
      const results: AgentResult[] = [
        makeAgentResult({ completion_status: 'DONE' }),
        makeAgentResult({ completion_status: 'DONE' }),
        makeAgentResult({ completion_status: 'CRASHED' }),
        makeAgentResult({ completion_status: 'INCOMPLETE' }),
      ];

      const summary = generateSummary(results);

      expect(summary.totalAgents).toBe(4);
      expect(summary.completionRate).toBeCloseTo(0.5, 2);
    });

    test('computes per-category stats', () => {
      const results: AgentResult[] = [
        makeAgentResult({ prompt_category: 'web', cost_usd: 2.0 }),
        makeAgentResult({ prompt_category: 'web', cost_usd: 4.0 }),
        makeAgentResult({ prompt_category: 'cli', cost_usd: 1.0 }),
      ];

      const summary = generateSummary(results);

      const webCat = summary.perCategory.find((c) => c.category === 'web');
      const cliCat = summary.perCategory.find((c) => c.category === 'cli');

      expect(webCat!.agentCount).toBe(2);
      expect(webCat!.meanCostUsd).toBeCloseTo(3.0, 2);
      expect(cliCat!.agentCount).toBe(1);
      expect(cliCat!.meanCostUsd).toBeCloseTo(1.0, 2);
    });

    test('handles empty results array', () => {
      const summary = generateSummary([]);

      expect(summary.totalAgents).toBe(0);
      expect(summary.completionRate).toBe(0);
      expect(summary.perArm).toHaveLength(0);
      expect(summary.perPrompt).toHaveLength(0);
      expect(summary.perCategory).toHaveLength(0);
    });

    test('computes smoke pass rate correctly', () => {
      const results: AgentResult[] = [
        makeAgentResult({
          arm: 'claude-mem',
          smoke_tests: { total: 4, passed: 3, failed: 1, skipped: 0, results: [] },
        }),
        makeAgentResult({
          arm: 'claude-mem',
          smoke_tests: { total: 4, passed: 4, failed: 0, skipped: 0, results: [] },
        }),
      ];

      const summary = generateSummary(results);
      const cmem = summary.perArm.find((a) => a.arm === 'claude-mem');

      // 7 passed out of 8 total = 0.875
      expect(cmem!.smokePassRate).toBeCloseTo(0.875, 3);
    });
  });

  describe('validateAgainstSchema', () => {
    test('validates a correct AgentResult against the schema', async () => {
      const result = makeAgentResult({
        agent_id: 'cmem-07-1',
        arm: 'claude-mem',
        prompt_id: '07-retro-forge',
        prompt_category: 'web',
        raw_log_sha256: 'a'.repeat(64),
      });

      const isValid = await validateAgainstSchema(result, SCHEMA_PATH);
      expect(isValid).toBe(true);
    });

    test('rejects result with invalid arm value', async () => {
      const result = makeAgentResult({
        arm: 'invalid-arm' as any,
      });

      const isValid = await validateAgainstSchema(result, SCHEMA_PATH);
      expect(isValid).toBe(false);
    });

    test('rejects result with invalid schema_version', async () => {
      const result = makeAgentResult({
        schema_version: '2.0',
      });

      const isValid = await validateAgainstSchema(result, SCHEMA_PATH);
      expect(isValid).toBe(false);
    });

    test('rejects result with invalid completion_status', async () => {
      const result = makeAgentResult({
        completion_status: 'UNKNOWN' as any,
      });

      const isValid = await validateAgainstSchema(result, SCHEMA_PATH);
      expect(isValid).toBe(false);
    });
  });
});

// --- Helper to build test AgentResult ---

function makeAgentResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    schema_version: '1.0',
    agent_id: 'cmem-07-1',
    arm: 'claude-mem',
    prompt_id: '07-retro-forge',
    prompt_category: 'web',
    model_version: 'claude-opus-4-6',
    tokens: {
      input: 5000,
      output: 2000,
      cache_creation: 500,
      cache_read: 300,
      total: 7800,
    },
    cost_usd: 1.25,
    wall_clock_seconds: 600,
    completion_status: 'DONE',
    smoke_tests: {
      total: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      results: [
        { name: 'test1', passed: true, actual: 'ok' },
        { name: 'test2', passed: true, actual: 'ok' },
        { name: 'test3', passed: false, actual: 'fail' },
      ],
    },
    rubric_scores: {
      functionality: 7,
      code_quality: 6,
      ux: 5,
      completeness: 7,
    },
    judge_blinded: true,
    industry_baseline: {
      source: 'anthropic',
      reference_cost_usd: 2.53,
      reference_duration_seconds: 1200,
      reference_architecture: '3-agent pipeline',
    },
    raw_log_sha256: 'a'.repeat(64),
    ...overrides,
  };
}
