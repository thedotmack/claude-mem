import { describe, expect, it } from 'bun:test';
import { canonicalJson, deterministicKey } from '../../../src/storage/postgres/utils.js';

describe('Postgres canonical JSON property identities', () => {
  it('retains literal prototype-named properties at every depth', () => {
    const value = JSON.parse('{"z":[{"__proto__":{"id":"nested"}}],"__proto__":{"id":"root"},"constructor":"literal"}');
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
    expect(canonicalJson(value)).toBe('{"__proto__":{"id":"root"},"constructor":"literal","z":[{"__proto__":{"id":"nested"}}]}');
  });
  it('distinguishes payloads that differ only in a prototype-named property', () => {
    expect(deterministicKey([JSON.parse('{"__proto__":{"id":"first"}}')]))
      .not.toBe(deterministicKey([JSON.parse('{"__proto__":{"id":"second"}}')]));
  });
  it('keeps insertion-order independent keys and ordinary names stable', () => {
    expect(deterministicKey([{b: 2, a: 1}])).toBe(deterministicKey([{a: 1, b: 2}]));
    expect(canonicalJson({b: 2, a: 1})).toBe('{"a":1,"b":2}');
  });
});
