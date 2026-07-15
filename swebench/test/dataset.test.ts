import { describe, expect, test } from 'bun:test';
import {
  downloadDataset,
  normalizeTestList,
  parseInstances,
  resolveDatasetId,
  selectInstances,
} from '../src/dataset.ts';

describe('normalizeTestList', () => {
  test('parses a JSON-encoded string', () => {
    expect(normalizeTestList('["a::t1", "a::t2"]')).toEqual(['a::t1', 'a::t2']);
  });
  test('passes through arrays', () => {
    expect(normalizeTestList(['x', 'y'])).toEqual(['x', 'y']);
  });
  test('treats a bare non-JSON string as a single id', () => {
    expect(normalizeTestList('pkg/test_mod.py::test_thing')).toEqual(['pkg/test_mod.py::test_thing']);
  });
  test('empty/nullish → []', () => {
    expect(normalizeTestList('')).toEqual([]);
    expect(normalizeTestList(undefined)).toEqual([]);
    expect(normalizeTestList(null)).toEqual([]);
  });
});

describe('resolveDatasetId', () => {
  test('maps friendly keys', () => {
    expect(resolveDatasetId('verified')).toBe('princeton-nlp/SWE-bench_Verified');
    expect(resolveDatasetId('lite')).toBe('princeton-nlp/SWE-bench_Lite');
  });
  test('passes through raw ids', () => {
    expect(resolveDatasetId('my-org/My_Dataset')).toBe('my-org/My_Dataset');
  });
});

describe('parseInstances', () => {
  test('parses JSONL', () => {
    const text = [
      JSON.stringify({ instance_id: 'a', repo: 'o/a', base_commit: 'c1', problem_statement: 'p' }),
      JSON.stringify({ instance_id: 'b', repo: 'o/b', base_commit: 'c2', problem_statement: 'p' }),
    ].join('\n');
    const out = parseInstances(text);
    expect(out.map((i) => i.instance_id)).toEqual(['a', 'b']);
  });
  test('parses a JSON array', () => {
    const text = JSON.stringify([{ instance_id: 'a', repo: 'o/a', base_commit: 'c', problem_statement: 'p' }]);
    expect(parseInstances(text)).toHaveLength(1);
  });
  test('rejects rows without instance_id', () => {
    expect(() => parseInstances(JSON.stringify([{ repo: 'x' }]))).toThrow(/instance_id/);
  });
});

describe('selectInstances', () => {
  const mk = (id: string) => ({ instance_id: id, repo: 'o/r', base_commit: 'c', problem_statement: 'p' });
  const all = ['a', 'b', 'c', 'd'].map(mk);
  test('filters by ids', () => {
    expect(selectInstances(all, { ids: ['b', 'd'] }).map((i) => i.instance_id)).toEqual(['b', 'd']);
  });
  test('offset + count slice', () => {
    expect(selectInstances(all, { offset: 1, count: 2 }).map((i) => i.instance_id)).toEqual(['b', 'c']);
  });
  test('count only', () => {
    expect(selectInstances(all, { count: 1 }).map((i) => i.instance_id)).toEqual(['a']);
  });
});

describe('downloadDataset', () => {
  test('paginates the HF rows API', async () => {
    const pages: Record<number, unknown> = {
      0: { num_rows_total: 3, rows: [{ row: { instance_id: 'a', repo: 'o/a', base_commit: 'c', problem_statement: 'p' } }, { row: { instance_id: 'b', repo: 'o/b', base_commit: 'c', problem_statement: 'p' } }] },
      2: { num_rows_total: 3, rows: [{ row: { instance_id: 'c', repo: 'o/c', base_commit: 'c', problem_statement: 'p' } }] },
    };
    const seen: number[] = [];
    const fetchImpl = (async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      seen.push(offset);
      return new Response(JSON.stringify(pages[offset] ?? { rows: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await downloadDataset({ dataset: 'x/y', fetchImpl, split: 'test' });
    expect(out.map((i) => i.instance_id)).toEqual(['a', 'b', 'c']);
    expect(seen).toEqual([0, 2]);
  });

  test('throws on non-ok response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(downloadDataset({ dataset: 'x/y', fetchImpl })).rejects.toThrow(/500/);
  });
});
