import { describe, it, expect } from 'bun:test';
import { pageMatchingRows, streamRows } from '../../../src/services/sqlite/stream-rows.js';

type Row = { id: number; direct: boolean };
const rows: Row[] = [
  { id: 1, direct: false },
  { id: 2, direct: true },
  { id: 3, direct: false },
  { id: 4, direct: true },
  { id: 5, direct: true },
];

/** A statement as bun:sqlite before v1.1.31 exposes it: no iterate(), only all(). */
function legacyStatement() {
  const calls = { finalize: 0, all: [] as unknown[][] };
  const statement = {
    all: (...params: unknown[]) => { calls.all.push(params); return rows; },
    finalize: () => { calls.finalize++; },
  };
  return { statement, calls };
}

describe('pageMatchingRows', () => {
  it('pages the matching rows through the .all() fallback when iterate() is missing', () => {
    const { statement, calls } = legacyStatement();
    const page = pageMatchingRows<Row>(statement, ['project', 1], row => row.direct, { limit: '1', offset: '1' });
    expect(page.map(row => row.id)).toEqual([4]);
    expect(calls.all).toEqual([['project', 1]]);
    expect(calls.finalize).toBe(1);
  });

  it('finalizes the statement even when the page arguments are rejected', () => {
    const { statement, calls } = legacyStatement();
    expect(() => pageMatchingRows<Row>(statement, [], row => row.direct, { limit: -1 })).toThrow('limit must be a non-negative integer');
    expect(() => pageMatchingRows<Row>(statement, [], row => row.direct, { limit: 1, offset: 0.5 })).toThrow('offset must be an integer');
    expect(calls.all).toEqual([]);
    expect(calls.finalize).toBe(2);
  });
});

describe('streamRows', () => {
  it('passes the bound parameters to iterate() when the runtime has it', () => {
    const seen: unknown[][] = [];
    const statement = {
      iterate: (...params: unknown[]) => { seen.push(params); return rows[Symbol.iterator](); },
      all: () => [],
    };
    expect([...streamRows(statement, 'a', 2)]).toEqual(rows);
    expect(seen).toEqual([['a', 2]]);
  });
});
