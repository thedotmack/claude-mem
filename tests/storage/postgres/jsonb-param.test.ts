import { describe, expect, it } from 'bun:test';
import { toJsonbParam } from '../../../src/storage/postgres/utils.js';

describe('toJsonbParam', () => {
  it('strips NUL from nested string values and keeps the rest', () => {
    const out = toJsonbParam({ tool_response: { stdout: 'a\u0000b\u0000' }, list: ['\u0000x'], n: 1 });
    expect(out).not.toContain('\\u0000');
    expect(JSON.parse(out)).toEqual({ tool_response: { stdout: 'ab' }, list: ['x'], n: 1 });
  });

  it('leaves a literal backslash-u0000 text untouched', () => {
    const literal = 'path\\u0000name';
    expect(JSON.parse(toJsonbParam({ s: literal })).s).toBe(literal);
  });
});
