import { describe, expect, it, mock } from 'bun:test';
import { scopeRowIdsFor } from '../../../src/services/worker/search/scope-row-ids.js';

describe('scopeRowIdsFor (#5091)', () => {
  const categories = { observations: true, sessions: false, prompts: false };

  it('lists the rows on first use and reuses them for the search\'s later windows', () => {
    const getSearchScopeRowIds = mock(() => [7, 9]);
    const scope = { project: 'p', platformSource: 'codex' };
    const rowIds = scopeRowIdsFor({ getSearchScopeRowIds } as any, categories, scope);

    expect(getSearchScopeRowIds).not.toHaveBeenCalled();
    expect(rowIds(5000)).toEqual([7, 9]);
    expect(rowIds(5000)).toEqual([7, 9]);
    expect(getSearchScopeRowIds).toHaveBeenCalledTimes(1);
    expect(getSearchScopeRowIds).toHaveBeenCalledWith(categories, scope, 5000);
  });

  it('also reuses a scope that was too large to list', () => {
    const getSearchScopeRowIds = mock(() => null);
    const rowIds = scopeRowIdsFor({ getSearchScopeRowIds } as any, categories, {});

    expect(rowIds(5000)).toBeNull();
    expect(rowIds(5000)).toBeNull();
    expect(getSearchScopeRowIds).toHaveBeenCalledTimes(1);
  });

  it('reports a failed listing once, then answers null without retrying it', () => {
    const getSearchScopeRowIds = mock(() => { throw new Error('database is locked'); });
    const rowIds = scopeRowIdsFor({ getSearchScopeRowIds } as any, categories, {});

    expect(() => rowIds(5000)).toThrow('database is locked');
    expect(rowIds(5000)).toBeNull();
    expect(getSearchScopeRowIds).toHaveBeenCalledTimes(1);
  });
});
