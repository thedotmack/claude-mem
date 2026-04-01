import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { calculateAgreement } from '../src/eval/calibration.js';
import { runCalibration } from '../src/eval/calibration.js';
import type { CalibrationReport } from '../src/eval/calibration.js';
import type { JudgeScores } from '../src/eval/llm-judge.js';

const TEMP_DIR = join(import.meta.dir, '..', '.test-tmp-calibration');

function makeJudgeScores(
  functionality: number,
  codeQuality: number,
  ux: number,
  completeness: number,
): JudgeScores {
  return {
    functionality,
    code_quality: codeQuality,
    ux,
    completeness,
    reasoning: {
      functionality: 'test reasoning',
      code_quality: 'test reasoning',
      ux: 'test reasoning',
      completeness: 'test reasoning',
    },
  };
}

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

describe('calibration', () => {
  beforeEach(async () => {
    await ensureTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  describe('calculateAgreement', () => {
    test('exact match scores → 100% agreement (all dimensions true)', () => {
      const human = makeJudgeScores(5, 7, 5, 7);
      const llm = makeJudgeScores(5, 7, 5, 7);

      const agreement = calculateAgreement(human, llm);

      expect(agreement.functionality).toBe(true);
      expect(agreement.code_quality).toBe(true);
      expect(agreement.ux).toBe(true);
      expect(agreement.completeness).toBe(true);

      const agreementCount = Object.values(agreement).filter(Boolean).length;
      expect(agreementCount).toBe(4);
    });

    test('±1 tolerance scores → 100% agreement', () => {
      const human = makeJudgeScores(5, 7, 5, 7);
      const llm = makeJudgeScores(5, 6, 5, 8);

      const agreement = calculateAgreement(human, llm);

      expect(agreement.functionality).toBe(true);
      expect(agreement.code_quality).toBe(true); // 7 vs 6, diff=1
      expect(agreement.ux).toBe(true);
      expect(agreement.completeness).toBe(true); // 7 vs 8, diff=1

      const agreementCount = Object.values(agreement).filter(Boolean).length;
      expect(agreementCount).toBe(4);
    });

    test('one dimension off by 2 → 75% agreement (3/4 true)', () => {
      const human = makeJudgeScores(5, 7, 5, 7);
      const llm = makeJudgeScores(3, 7, 5, 7);

      const agreement = calculateAgreement(human, llm);

      expect(agreement.functionality).toBe(false); // 5 vs 3, diff=2
      expect(agreement.code_quality).toBe(true);
      expect(agreement.ux).toBe(true);
      expect(agreement.completeness).toBe(true);

      const agreementCount = Object.values(agreement).filter(Boolean).length;
      expect(agreementCount).toBe(3);
    });

    test('two dimensions off by 2+ → 50% agreement (2/4 true)', () => {
      const human = makeJudgeScores(5, 7, 5, 7);
      const llm = makeJudgeScores(3, 3, 5, 7);

      const agreement = calculateAgreement(human, llm);

      expect(agreement.functionality).toBe(false); // 5 vs 3, diff=2
      expect(agreement.code_quality).toBe(false); // 7 vs 3, diff=4
      expect(agreement.ux).toBe(true);
      expect(agreement.completeness).toBe(true);

      const agreementCount = Object.values(agreement).filter(Boolean).length;
      expect(agreementCount).toBe(2);
    });

    test('all dimensions off by 2+ → 0% agreement', () => {
      const human = makeJudgeScores(1, 1, 1, 1);
      const llm = makeJudgeScores(9, 9, 9, 9);

      const agreement = calculateAgreement(human, llm);

      const agreementCount = Object.values(agreement).filter(Boolean).length;
      expect(agreementCount).toBe(0);
    });

    test('boundary: exactly ±1 on all dimensions → 100% agreement', () => {
      const human = makeJudgeScores(5, 5, 5, 5);
      const llm = makeJudgeScores(6, 4, 6, 4);

      const agreement = calculateAgreement(human, llm);

      const agreementCount = Object.values(agreement).filter(Boolean).length;
      expect(agreementCount).toBe(4);
    });

    test('boundary: exactly ±2 on one dimension → that dimension false', () => {
      const human = makeJudgeScores(5, 5, 5, 5);
      const llm = makeJudgeScores(7, 5, 5, 5);

      const agreement = calculateAgreement(human, llm);

      expect(agreement.functionality).toBe(false); // diff=2
      expect(agreement.code_quality).toBe(true);
      expect(agreement.ux).toBe(true);
      expect(agreement.completeness).toBe(true);
    });
  });

  describe('runCalibration — empty calibration dir', () => {
    test('empty directory → passed=true (vacuously true)', async () => {
      const emptyCalibDir = join(TEMP_DIR, 'empty-calib');
      await mkdir(emptyCalibDir, { recursive: true });

      // We need a rubric file
      const rubricPath = join(TEMP_DIR, 'rubric.yaml');
      await writeFile(
        rubricPath,
        'dimensions:\n  functionality:\n    weight: 0.30\n',
      );

      const report = await runCalibration(
        emptyCalibDir,
        rubricPath,
        'fake-api-key',
        'claude-sonnet-4-20250514',
      );

      expect(report.totalProjects).toBe(0);
      expect(report.passed).toBe(true);
      expect(report.agreementPercentage).toBe(100);
      expect(report.iterations).toBe(0);
      expect(report.entries).toEqual([]);
    });

    test('non-existent directory → passed=true (vacuously true)', async () => {
      const rubricPath = join(TEMP_DIR, 'rubric.yaml');
      await writeFile(
        rubricPath,
        'dimensions:\n  functionality:\n    weight: 0.30\n',
      );

      const report = await runCalibration(
        join(TEMP_DIR, 'does-not-exist'),
        rubricPath,
        'fake-api-key',
        'claude-sonnet-4-20250514',
      );

      expect(report.totalProjects).toBe(0);
      expect(report.passed).toBe(true);
      expect(report.iterations).toBe(0);
    });
  });

  describe('calibration report structure', () => {
    test('report has all required fields', async () => {
      const emptyCalibDir = join(TEMP_DIR, 'struct-check');
      await mkdir(emptyCalibDir, { recursive: true });

      const rubricPath = join(TEMP_DIR, 'rubric2.yaml');
      await writeFile(
        rubricPath,
        'dimensions:\n  functionality:\n    weight: 0.30\n',
      );

      const report = await runCalibration(
        emptyCalibDir,
        rubricPath,
        'fake-api-key',
        'claude-sonnet-4-20250514',
      );

      // Verify all required fields exist
      expect(typeof report.totalProjects).toBe('number');
      expect(typeof report.agreementPercentage).toBe('number');
      expect(typeof report.perDimension).toBe('object');
      expect(typeof report.passed).toBe('boolean');
      expect(typeof report.iterations).toBe('number');
      expect(Array.isArray(report.entries)).toBe(true);

      // Verify perDimension has all 4 dimensions
      expect(typeof report.perDimension.functionality).toBe('number');
      expect(typeof report.perDimension.code_quality).toBe('number');
      expect(typeof report.perDimension.ux).toBe('number');
      expect(typeof report.perDimension.completeness).toBe('number');
    });

    test('agreement percentage is between 0 and 100', async () => {
      const emptyCalibDir = join(TEMP_DIR, 'pct-check');
      await mkdir(emptyCalibDir, { recursive: true });

      const rubricPath = join(TEMP_DIR, 'rubric3.yaml');
      await writeFile(
        rubricPath,
        'dimensions:\n  functionality:\n    weight: 0.30\n',
      );

      const report = await runCalibration(
        emptyCalibDir,
        rubricPath,
        'fake-api-key',
        'claude-sonnet-4-20250514',
      );

      expect(report.agreementPercentage).toBeGreaterThanOrEqual(0);
      expect(report.agreementPercentage).toBeLessThanOrEqual(100);
    });
  });
});
