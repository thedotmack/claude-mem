import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { evaluateExpected } from '../src/eval/smoke-runner.js';
import type { SmokeResults } from '../src/eval/smoke-runner.js';
import { runSmokeTests } from '../src/eval/smoke-runner.js';

const TEMP_DIR = join(import.meta.dir, '..', '.test-tmp-smoke');

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

describe('smoke-runner', () => {
  beforeEach(async () => {
    await ensureTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  describe('evaluateExpected — status:CODE', () => {
    test('status:200 passes when stdout contains 200', () => {
      const result = evaluateExpected('status:200', '200', 0);
      expect(result.passed).toBe(true);
      expect(result.actual).toContain('200');
    });

    test('status:200 fails when stdout contains 404', () => {
      const result = evaluateExpected('status:200', '404', 0);
      expect(result.passed).toBe(false);
      expect(result.actual).toContain('404');
    });

    test('status:201 passes when stdout contains 201', () => {
      const result = evaluateExpected('status:201', '201', 0);
      expect(result.passed).toBe(true);
    });

    test('status:200 passes when 200 is embedded in longer output', () => {
      const result = evaluateExpected(
        'status:200',
        'HTTP/1.1 200 OK\r\nContent-Type: text/html',
        0,
      );
      expect(result.passed).toBe(true);
    });

    test('status:200 fails on empty stdout', () => {
      const result = evaluateExpected('status:200', '', 0);
      expect(result.passed).toBe(false);
    });
  });

  describe('evaluateExpected — contains:STRING', () => {
    test('contains:article passes when stdout contains the string', () => {
      const result = evaluateExpected(
        'contains:article',
        'found article here',
        0,
      );
      expect(result.passed).toBe(true);
    });

    test('contains:article fails when string not in stdout', () => {
      const result = evaluateExpected(
        'contains:article',
        'no match here',
        0,
      );
      expect(result.passed).toBe(false);
    });

    test('contains:article is case-insensitive', () => {
      const result = evaluateExpected(
        'contains:article',
        'Found ARTICLE Here',
        0,
      );
      expect(result.passed).toBe(true);
    });

    test('contains: with empty stdout fails', () => {
      const result = evaluateExpected('contains:article', '', 0);
      expect(result.passed).toBe(false);
    });

    test('contains:vault passes with JSON response', () => {
      const result = evaluateExpected(
        'contains:vault',
        '{"vault_id":1,"created_at":"2024-01-01"}',
        0,
      );
      expect(result.passed).toBe(true);
    });
  });

  describe('evaluateExpected — exit_0', () => {
    test('exit_0 passes when exit code is 0', () => {
      const result = evaluateExpected('exit_0', '', 0);
      expect(result.passed).toBe(true);
      expect(result.actual).toContain('exit_code=0');
    });

    test('exit_0 fails when exit code is 1', () => {
      const result = evaluateExpected('exit_0', '', 1);
      expect(result.passed).toBe(false);
      expect(result.actual).toContain('exit_code=1');
    });

    test('exit_0 fails when exit code is 127', () => {
      const result = evaluateExpected('exit_0', 'command not found', 127);
      expect(result.passed).toBe(false);
    });
  });

  describe('evaluateExpected — unknown clause', () => {
    test('unknown clause fails gracefully', () => {
      const result = evaluateExpected('unknown:foo', 'whatever', 0);
      expect(result.passed).toBe(false);
      expect(result.actual).toContain('unknown expected clause');
    });
  });

  describe('runSmokeTests — empty smoke_tests', () => {
    test('returns all zeros with no failures for empty array', async () => {
      const results = await runSmokeTests(
        'test-agent',
        'test-prompt',
        [],
        'fake-container-id',
      );

      expect(results.total).toBe(0);
      expect(results.passed).toBe(0);
      expect(results.failed).toBe(0);
      expect(results.skipped).toBe(0);
      expect(results.results).toEqual([]);
      expect(results.agentId).toBe('test-agent');
      expect(results.promptId).toBe('test-prompt');
    });

    test('writes results to expected path when resultsDir provided', async () => {
      const results = await runSmokeTests(
        'test-agent-write',
        'test-prompt',
        [],
        'fake-container-id',
        TEMP_DIR,
      );

      const writtenPath = join(
        TEMP_DIR,
        'test-agent-write',
        'smoke-results.json',
      );
      const writtenContent = await readFile(writtenPath, 'utf-8');
      const parsed = JSON.parse(writtenContent) as SmokeResults;

      expect(parsed.agentId).toBe('test-agent-write');
      expect(parsed.promptId).toBe('test-prompt');
      expect(parsed.total).toBe(0);
      expect(parsed.results).toEqual([]);
    });
  });
});
