import { test, expect, describe } from 'bun:test';
import { shouldUseHybrid, RoutableObservation } from '../../../../src/services/worker/search/enhanced/routing.js';

function r(text: string): RoutableObservation {
  return { title: text, subtitle: null, narrative: null, facts: null };
}

describe('shouldUseHybrid', () => {
  test('no FTS5 results => hybrid (chroma may still find matches)', () => {
    const d = shouldUseHybrid('worker restart database', []);
    expect(d.useHybrid).toBe(true);
    expect(d.reason).toBe('fts-empty');
  });

  test('top hit covers all query tokens => FTS5-only', () => {
    const d = shouldUseHybrid('worker restart migration', [
      r('worker restart migration completed cleanly'),
    ]);
    expect(d.useHybrid).toBe(false);
    expect(d.reason).toBe('fts-confident');
    expect(d.topCoverage).toBe(1);
  });

  test('top hit covers too few query tokens => hybrid', () => {
    const d = shouldUseHybrid('worker restart migration rollback', [
      r('worker logs unrelated'),
    ]);
    expect(d.useHybrid).toBe(true);
    expect(d.reason).toBe('fts-flat');
  });

  test('query with no significant tokens => FTS5-only (nothing to fuse on)', () => {
    const d = shouldUseHybrid('the a is of', [r('anything')]);
    expect(d.useHybrid).toBe(false);
    expect(d.reason).toBe('no-significant-tokens');
  });
});
