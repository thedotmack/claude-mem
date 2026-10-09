import { describe, expect, it } from 'bun:test';
import { ProgressiveSearch } from '../../src/shared/progressive-search.js';
import { runProgressiveSearchCases } from './progressive-search-cases.js';

describe('portable progressive search adversarial protocol', () => {
  it('enforces bounded progressive disclosure, signed state and conservative automatic selection', async () => {
    const result = await runProgressiveSearchCases(ProgressiveSearch);
    expect(result.count).toBeGreaterThanOrEqual(25);
  });
});
