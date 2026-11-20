import { test, expect } from 'bun:test';
import { runContractChecks } from '../../scripts/media/contract-checks.js';

test('v1 golden parity, bounds, rejected byte/locator leakage and stable identity', () => {
  expect(runContractChecks()).toBeGreaterThan(40);
});
