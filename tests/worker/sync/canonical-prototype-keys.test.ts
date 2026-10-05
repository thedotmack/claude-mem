import { describe, expect, it } from 'bun:test';
import { canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';

describe('canonical payload property preservation', () => {
  it('retains ordinary JSON keys named __proto__ at every depth', () => {
    const input = JSON.parse('{"__proto__":{"kept":1},"nested":{"__proto__":"evidence"}}');
    const output = JSON.parse(canonicalJson(input));
    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(output.__proto__).toEqual({ kept: 1 });
    expect(output.nested.__proto__).toBe('evidence');
  });
  it('does not hash distinct payloads as identical after dropping a property', () => {
    expect(sha256Base64Url(canonicalJson(JSON.parse('{"__proto__":"one"}'))))
      .not.toBe(sha256Base64Url(canonicalJson(JSON.parse('{"__proto__":"two"}'))));
  });
});
