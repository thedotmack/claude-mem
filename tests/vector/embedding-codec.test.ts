import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { encodeEmbedding, decodeEmbedding } from '../../src/services/vector/schema.js';

/**
 * encodeEmbedding hands SQLite a Uint8Array view over the Float32Array's own
 * buffer rather than a copy. That is deliberate — copying every vector on the
 * write path would be wasteful — but it is only safe because bun:sqlite copies
 * the bytes when binding. These pin that assumption: if it ever stops holding,
 * writes would start aliasing live vectors and the corruption would be silent.
 */
describe('embedding codec', () => {
  it('round-trips values exactly', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, e BLOB)');
    const vec = new Float32Array([1.5, -2.25, 0, 3.125]);
    db.prepare('INSERT INTO t VALUES (1, ?)').run(encodeEmbedding(vec));
    const back = decodeEmbedding((db.prepare('SELECT e FROM t WHERE id=1').get() as any).e);
    expect(Array.from(back)).toEqual(Array.from(vec));
  });

  it('is unaffected by mutation of the source vector after the write', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, e BLOB)');
    const vec = new Float32Array([9, 9, 9, 9]);
    db.prepare('INSERT INTO t VALUES (1, ?)').run(encodeEmbedding(vec));
    vec[0] = -1;
    const back = decodeEmbedding((db.prepare('SELECT e FROM t WHERE id=1').get() as any).e);
    expect(back[0]).toBe(9);
  });

  it('encodes a subarray view, honouring byteOffset', () => {
    // LocalEmbedder slices a batch result, so views with a non-zero byteOffset
    // reach this path in production.
    const backing = new Float32Array([0, 0, 7, 8]);
    const back = decodeEmbedding(encodeEmbedding(backing.subarray(2)));
    expect(Array.from(back)).toEqual([7, 8]);
  });

  it('decodes into a buffer independent of the source bytes', () => {
    const vec = new Float32Array([4, 5]);
    const bytes = encodeEmbedding(vec);
    const back = decodeEmbedding(bytes);
    vec[0] = 99;
    expect(back[0]).toBe(4);
  });
});
