import { test, expect } from 'bun:test';
import { runEvaluationChecks } from '../../scripts/media/evaluation-checks.js';

test('public corpus, zero-call default, bounded spend/retries/deadline and truthful accounting', async () => {
  const result = await runEvaluationChecks();
  expect(result.checks).toBeGreaterThan(30);
  expect(result.images).toBe(9);
}, 30_000);
