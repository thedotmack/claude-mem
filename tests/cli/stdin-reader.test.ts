
import { describe, it, expect, afterEach } from 'bun:test';

import { readJsonFromStdin } from '../../src/cli/stdin-reader.js';
import { installFakeStdin, restoreStdin } from '../fake-stdin.js';

afterEach(() => {
  restoreStdin();
});

describe('readJsonFromStdin — onEnd contract (#2089)', () => {
  it('resolves with parsed JSON when stdin yields a complete object', async () => {
    installFakeStdin('{"hello":"world"}');
    const result = await readJsonFromStdin();
    expect(result).toEqual({ hello: 'world' });
  });

  it('resolves with undefined when stdin closes empty', async () => {
    installFakeStdin('');
    const result = await readJsonFromStdin();
    expect(result).toBeUndefined();
  });

  it('rejects when stdin closes with non-empty but unparseable bytes', async () => {
    installFakeStdin('{"truncated":');
    await expect(readJsonFromStdin()).rejects.toThrow(/Malformed JSON at stdin EOF/);
  });

  it('rejects when stdin closes with junk that is clearly not JSON', async () => {
    installFakeStdin('not json at all');
    await expect(readJsonFromStdin()).rejects.toThrow(/Malformed JSON at stdin EOF/);
  });
});
