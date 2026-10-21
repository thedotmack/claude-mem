import { describe, expect, it } from 'bun:test';
import { ProgressiveSearch } from '../../src/shared/progressive-search.js';
import { runProgressiveSearchCases } from './progressive-search-cases.js';

describe('portable Dumb search contract', () => {
  it('runs bounded one-call selection and keeps internal state out of model text', async () => {
    const result = await runProgressiveSearchCases(ProgressiveSearch);
    expect(result.count).toBeGreaterThanOrEqual(20);
  });
});
