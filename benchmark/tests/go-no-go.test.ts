import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { checkPhaseOneGate } from '../src/go-no-go.js';
import type { GoNoGoResult } from '../src/go-no-go.js';

const TEMP_DIR = join(import.meta.dir, '..', '.test-tmp-go-no-go');

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

/**
 * Creates a minimal agent directory with the given completion status.
 */
async function createAgentDirectory(
  agentId: string,
  completionStatus: 'DONE' | 'CRASHED' | 'KILLED' | 'INCOMPLETE',
  options?: {
    includeSmokeResults?: boolean;
    includeAgentResult?: boolean;
    includeJudgeLog?: boolean;
    agentResultOverrides?: Record<string, unknown>;
    promptId?: string;
  },
): Promise<void> {
  const agentDir = join(TEMP_DIR, agentId);
  await mkdir(agentDir, { recursive: true });

  // Write sentinel file based on completion status
  if (completionStatus === 'DONE') {
    await writeFile(join(agentDir, 'DONE.md'), '# Done\nCompleted successfully.');
  } else if (completionStatus === 'CRASHED') {
    await writeFile(join(agentDir, 'CRASHED.md'), '# Crashed\nAgent crashed.');
  } else if (completionStatus === 'KILLED') {
    await writeFile(join(agentDir, 'KILLED.md'), '# Killed\nKilled by operator.');
  }
  // INCOMPLETE: no sentinel file

  // Optionally include smoke-results.json
  if (options?.includeSmokeResults !== false && completionStatus === 'DONE') {
    await writeFile(
      join(agentDir, 'smoke-results.json'),
      JSON.stringify({
        agentId,
        promptId: options?.promptId ?? '09-url-shortener',
        total: 3,
        passed: 2,
        failed: 1,
        skipped: 0,
        results: [],
      }),
    );
  }

  // Optionally include agent-result.json
  if (options?.includeAgentResult !== false && completionStatus === 'DONE') {
    const defaultResult = {
      schema_version: '1.0',
      agent_id: agentId,
      arm: agentId.startsWith('cmem') ? 'claude-mem' : 'vanilla',
      prompt_id: options?.promptId ?? '09-url-shortener',
      prompt_category: 'api',
      model_version: 'claude-opus-4-6',
      tokens: { input: 5000, output: 2000, cache_creation: 500, cache_read: 300, total: 7800 },
      cost_usd: 3.50,
      wall_clock_seconds: 600,
      completion_status: completionStatus,
      smoke_tests: { total: 3, passed: 2, failed: 1, skipped: 0, results: [] },
      rubric_scores: { functionality: 7, code_quality: 6, ux: 5, completeness: 7 },
      judge_blinded: true,
      industry_baseline: { source: 'none', reference_cost_usd: null, reference_duration_seconds: null, reference_architecture: null },
      raw_log_sha256: 'a'.repeat(64),
      ...options?.agentResultOverrides,
    };
    await writeFile(
      join(agentDir, 'agent-result.json'),
      JSON.stringify(defaultResult),
    );
  }

  // Optionally include judge-log.jsonl
  if (options?.includeJudgeLog) {
    const judgeEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      agentId,
      score: 'on-track',
      stage: 'building',
      reasoning: 'Active and progressing normally',
    });
    await writeFile(join(agentDir, 'judge-log.jsonl'), judgeEntry + '\n');
  }
}

/**
 * Creates a calibration report in the results directory.
 */
async function createCalibrationReport(
  agreementPercentage: number,
  totalProjects: number,
): Promise<void> {
  await writeFile(
    join(TEMP_DIR, 'calibration-report.json'),
    JSON.stringify({
      agreementPercentage,
      totalProjects,
      passed: agreementPercentage >= 75,
      perDimension: {
        functionality: agreementPercentage,
        code_quality: agreementPercentage,
        ux: agreementPercentage,
        completeness: agreementPercentage,
      },
      iterations: 1,
      entries: [],
    }),
  );
}

/**
 * Creates a judge heartbeat file in the results directory.
 */
async function createJudgeHeartbeat(): Promise<void> {
  await writeFile(
    join(TEMP_DIR, '.judge-heartbeat'),
    new Date().toISOString(),
  );
}

function findCriterion(result: GoNoGoResult, nameSubstring: string) {
  return result.criteria.find((c) =>
    c.name.toLowerCase().includes(nameSubstring.toLowerCase()),
  );
}

describe('go-no-go', () => {
  beforeEach(async () => {
    await ensureTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  describe('Criterion 1: Agent completion rate', () => {
    test('PASS: 9/10 agents DONE (90%)', async () => {
      // Create 9 DONE agents and 1 CRASHED
      for (let i = 1; i <= 9; i++) {
        await createAgentDirectory(`cmem-09-${i}`, 'DONE', { includeJudgeLog: true });
      }
      await createAgentDirectory('cmem-09-10', 'CRASHED');
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'completion rate');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
      expect(criterion!.value).toContain('90.');
    });

    test('FAIL: 8/10 agents DONE (80%)', async () => {
      // Create 8 DONE agents and 2 CRASHED
      for (let i = 1; i <= 8; i++) {
        await createAgentDirectory(`cmem-09-${i}`, 'DONE', { includeJudgeLog: true });
      }
      await createAgentDirectory('cmem-09-9', 'CRASHED');
      await createAgentDirectory('cmem-09-10', 'CRASHED');
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'completion rate');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });

    test('PASS: exactly 90% (9/10)', async () => {
      for (let i = 1; i <= 9; i++) {
        await createAgentDirectory(`vanilla-09-${i}`, 'DONE', { includeJudgeLog: true });
      }
      await createAgentDirectory('vanilla-09-10', 'KILLED');
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('vanilla-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'completion rate');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
    });
  });

  describe('Criterion 2: Calibration agreement', () => {
    test('PASS: agreement at 80%', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'calibration');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
    });

    test('FAIL: agreement at 60%', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createCalibrationReport(60, 10);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'calibration');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });

    test('FAIL: no calibration report', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createJudgeHeartbeat();

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'calibration');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });

    test('PASS: vacuously true with 0 projects', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createCalibrationReport(100, 0);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'calibration');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
    });
  });

  describe('Criterion 3: Industry prompt completion', () => {
    test('PASS: industry prompt agent completed', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'industry');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
    });

    test('FAIL: no industry prompt agents', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createAgentDirectory('cmem-10-1', 'DONE', { includeJudgeLog: true });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'industry');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });

    test('FAIL: industry prompt agent crashed', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createAgentDirectory('cmem-17-1', 'CRASHED');
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'industry');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });
  });

  describe('Criterion 4: Smoke test framework', () => {
    test('PASS: all completed agents have smoke results', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', {
        includeSmokeResults: true,
        includeJudgeLog: true,
      });
      await createAgentDirectory('cmem-09-2', 'DONE', {
        includeSmokeResults: true,
        includeJudgeLog: true,
      });
      // Crashed agents should not need smoke results
      await createAgentDirectory('cmem-09-3', 'CRASHED');
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'smoke test');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
    });

    test('FAIL: completed agent missing smoke results', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', {
        includeSmokeResults: true,
        includeJudgeLog: true,
      });
      await createAgentDirectory('cmem-09-2', 'DONE', {
        includeSmokeResults: false,
        includeJudgeLog: true,
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'smoke test');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });
  });

  describe('Criterion 5: Schema validation', () => {
    test('PASS: all completed agents have valid agent-result.json', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', {
        includeAgentResult: true,
        includeJudgeLog: true,
      });
      await createAgentDirectory('cmem-09-2', 'DONE', {
        includeAgentResult: true,
        includeJudgeLog: true,
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'schema');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
    });

    test('FAIL: completed agent missing agent-result.json', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', {
        includeAgentResult: true,
        includeJudgeLog: true,
      });
      await createAgentDirectory('cmem-09-2', 'DONE', {
        includeAgentResult: false,
        includeJudgeLog: true,
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'schema');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });
  });

  describe('Criterion 6: Judge monitoring', () => {
    test('PASS: heartbeat and judge logs present', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'telegram');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true);
    });

    test('FAIL: no heartbeat file', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createCalibrationReport(80, 5);
      // No heartbeat created

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'telegram');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });

    test('FAIL: no judge log entries', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: false });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'telegram');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(false);
    });
  });

  describe('Criterion 7: Cost sanity (soft gate)', () => {
    test('always passes regardless of cost', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', {
        includeJudgeLog: true,
        agentResultOverrides: { cost_usd: 50.0 }, // Very high cost
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'cost');
      expect(criterion).toBeDefined();
      expect(criterion!.passed).toBe(true); // Soft gate always passes
    });

    test('reports warning for high-cost agents', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', {
        includeJudgeLog: true,
        agentResultOverrides: { cost_usd: 25.0 },
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      // Add an industry prompt agent
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);
      const criterion = findCriterion(result, 'cost');
      expect(criterion).toBeDefined();
      expect(criterion!.details).toContain('WARNING');
    });
  });

  describe('Overall gate result', () => {
    test('overall PASS when all criteria pass', async () => {
      // Set up a scenario where all criteria pass
      for (let i = 1; i <= 9; i++) {
        await createAgentDirectory(`cmem-09-${i}`, 'DONE', { includeJudgeLog: true });
      }
      await createAgentDirectory('cmem-09-10', 'CRASHED');
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      const result = await checkPhaseOneGate(TEMP_DIR);
      expect(result.passed).toBe(true);
      expect(result.criteria).toHaveLength(7);
    });

    test('overall FAIL when any criterion fails', async () => {
      // 80% completion rate → Criterion 1 fails
      for (let i = 1; i <= 8; i++) {
        await createAgentDirectory(`cmem-09-${i}`, 'DONE', { includeJudgeLog: true });
      }
      await createAgentDirectory('cmem-09-9', 'CRASHED');
      await createAgentDirectory('cmem-09-10', 'CRASHED');
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();

      const result = await checkPhaseOneGate(TEMP_DIR);
      expect(result.passed).toBe(false);
    });

    test('output structure is correct', async () => {
      await createAgentDirectory('cmem-09-1', 'DONE', { includeJudgeLog: true });
      await createCalibrationReport(80, 5);
      await createJudgeHeartbeat();
      await createAgentDirectory('cmem-17-1', 'DONE', {
        includeJudgeLog: true,
        promptId: '17-retroforge',
      });

      const result = await checkPhaseOneGate(TEMP_DIR);

      // Verify structure
      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.criteria)).toBe(true);
      expect(result.criteria).toHaveLength(7);

      for (const criterion of result.criteria) {
        expect(typeof criterion.name).toBe('string');
        expect(typeof criterion.passed).toBe('boolean');
        expect(typeof criterion.value).toBe('string');
        expect(typeof criterion.threshold).toBe('string');
        expect(typeof criterion.details).toBe('string');
        expect(criterion.name.length).toBeGreaterThan(0);
      }
    });

    test('handles empty results directory', async () => {
      // TEMP_DIR is empty (no agents, no calibration, no heartbeat)
      const result = await checkPhaseOneGate(TEMP_DIR);

      // With no agents: completion rate is 0/0 = 0 → fail
      // No calibration → fail
      // No industry prompts → fail
      // No completed agents for smoke → passes (vacuously)
      // No completed agents for schema → passes (vacuously)
      // No heartbeat → fail
      // Cost is soft gate → passes
      expect(result.passed).toBe(false);
      expect(result.criteria).toHaveLength(7);
    });
  });
});
