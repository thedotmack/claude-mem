import { describe, expect, it } from 'bun:test';
import { parseVersionKey, compareVersionKeysDesc } from '../../src/shared/version-key.js';

describe('version-key — numeric semver comparator', () => {
  it('parses MAJOR.MINOR.PATCH, ignoring trailing text', () => {
    expect(parseVersionKey('13.10.4')).toEqual([13, 10, 4]);
    expect(parseVersionKey('2.1.176 (Claude Code)')).toEqual([2, 1, 176]);
  });

  it('sorts unparseable versions lowest', () => {
    expect(parseVersionKey('nightly')).toEqual([0, 0, 0]);
  });

  it('orders by numeric fields, not lexicographically (13.10.0 ranks above 13.9.2)', () => {
    const sorted = ['13.9.2', '13.10.0', '13.4.0', '13.11.0', '13.10.4']
      .map(parseVersionKey)
      .sort(compareVersionKeysDesc);
    // A lexicographic/string sort would rank "13.9.2" above "13.10.x" — the exact
    // skew bug (issue #3216). Numeric ordering must put 13.11.0 first, 13.9.2 last-but-one.
    expect(sorted).toEqual([[13, 11, 0], [13, 10, 4], [13, 10, 0], [13, 9, 2], [13, 4, 0]]);
  });
});
