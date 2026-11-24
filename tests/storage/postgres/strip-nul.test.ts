import { describe, expect, it } from 'bun:test';
import { stripNul } from '../../../src/storage/postgres/utils.js';
import { stripMemoryTagsFromJsonStrings } from '../../../src/utils/tag-stripping.js';

describe('stripNul', () => {
  it('removes NUL from nested string values and keys and keeps the rest', () => {
    const out = stripNul({ tool_response: { stdout: 'a\u0000b\u0000' }, list: ['\u0000x'], n: 1, ['k\u0000ey']: true });
    expect(JSON.stringify(out)).not.toContain('\\u0000');
    expect(out).toEqual({ tool_response: { stdout: 'ab' }, list: ['x'], n: 1, key: true });
  });

  it('leaves a literal backslash-u0000 text untouched', () => {
    const literal = 'path\\u0000name';
    expect(stripNul({ s: literal })).toEqual({ s: literal });
  });

  it('runs before tag stripping, so a NUL-split <private> tag is still removed', () => {
    const payload = { stdout: 'ok <priv\u0000ate>secret</priv\u0000ate> end' };
    const stored = JSON.stringify(stripMemoryTagsFromJsonStrings(stripNul(payload)));
    expect(stored).not.toContain('secret');
  });
});
