import { describe, it, expect } from 'bun:test';
import { buildBranchFilter } from '../../src/utils/branch-filter.js';

describe('buildBranchFilter', () => {
  it('returns empty sql and params when branches is null', () => {
    const result = buildBranchFilter(null);
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('returns empty sql and params when branches is empty array', () => {
    const result = buildBranchFilter([]);
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('builds correct SQL for single branch', () => {
    const result = buildBranchFilter(['main']);
    expect(result.sql).toBe('AND (branch IS NULL OR branch IN (?))');
    expect(result.params).toEqual(['main']);
  });

  it('builds correct SQL with table alias and multiple branches', () => {
    const result = buildBranchFilter(['main', 'feature/x'], 'o');
    expect(result.sql).toBe('AND (o.branch IS NULL OR o.branch IN (?,?))');
    expect(result.params).toEqual(['main', 'feature/x']);
  });
});
