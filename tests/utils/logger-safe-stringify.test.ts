import { describe, it, expect } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

// safeStringify is private; exercise it directly to prove the DEBUG-mode
// serializer can't overflow the stack the way a plain JSON.stringify would.
const stringify = (data: unknown, indent?: number): string =>
  (logger as any).safeStringify(data, indent);

describe('logger.safeStringify', () => {
  it('serializes ordinary objects like JSON.stringify', () => {
    expect(stringify({ a: 1, b: 'x' })).toBe(JSON.stringify({ a: 1, b: 'x' }));
    expect(stringify({ a: 1 }, 2)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('does NOT overflow on a deeply nested object', () => {
    // A plain JSON.stringify throws RangeError here.
    let deep: any = {};
    let cursor = deep;
    for (let i = 0; i < 100_000; i++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    let out = '';
    expect(() => { out = stringify(deep, 2); }).not.toThrow();
    expect(out).toContain('[Object]'); // truncated past the depth cap
  });

  it('does NOT overflow on a deeply nested array', () => {
    let arr: any = [];
    let cursor = arr;
    for (let i = 0; i < 100_000; i++) {
      const child: any[] = [];
      cursor.push(child);
      cursor = child;
    }
    expect(() => stringify(arr, 2)).not.toThrow();
  });

  it('handles self-referential (circular) structures', () => {
    const cyclic: any = { name: 'root' };
    cyclic.self = cyclic;
    let out = '';
    expect(() => { out = stringify(cyclic, 2); }).not.toThrow();
    expect(out).toContain('[Circular]');
    expect(out).toContain('root');
  });

  it('handles BigInt without throwing', () => {
    let out = '';
    expect(() => { out = stringify({ big: 10n }); }).not.toThrow();
    expect(out).toContain('10n');
  });

  it('survives a throwing getter', () => {
    const obj = {
      get boom(): string { throw new Error('nope'); },
      ok: 1,
    };
    let out = '';
    expect(() => { out = stringify(obj); }).not.toThrow();
    expect(out).toContain('[unreadable]');
    expect(out).toContain('"ok":1');
  });
});
