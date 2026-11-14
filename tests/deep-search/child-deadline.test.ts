// SPDX-License-Identifier: Apache-2.0
//
// The deep-search child measures its deadline with Date.now(), while the
// parent measures the same budget with performance.now(). The value handed to
// the child must therefore come from the remaining budget at dispatch.

import { describe, expect, it } from 'bun:test';
import { childDeadline } from '../../src/services/deep-search/DeepSearchClient.js';

describe('childDeadline', () => {
  it('hands the child the remaining budget from the dispatch moment', () => {
    expect(childDeadline(5_000, 1_000, 1_000_000)).toBe(1_004_000);
  });

  it('never hands the child a dead or negative window', () => {
    expect(childDeadline(5_000, 9_000, 1_000_000)).toBe(1_000_001);
  });
});