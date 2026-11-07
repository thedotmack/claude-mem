
import { describe, it, expect, afterEach } from 'bun:test';

import { readJsonFromStdin } from '../../src/cli/stdin-reader.js';
import { installFakeStdin, restoreStdin } from '../fake-stdin.js';
import { PassThrough } from 'node:stream';

afterEach(() => {
  restoreStdin();
});

describe('readJsonFromStdin — onEnd contract (#2089)', () => {
  it('accepts an injected open stream with fragmented UTF-8 without removing other listeners', async () => {
    const input = new PassThrough();
    const owner = () => {};
    input.on('data', owner);
    try {
      const pending = readJsonFromStdin({ stdin: input, safetyTimeoutMs: 1000 });
      const data = Buffer.from('{"text":"Grüße 🙂"}');
      input.write(data.subarray(0, data.length - 4));
      input.write(data.subarray(data.length - 4));
      expect(await pending).toEqual({ text: 'Grüße 🙂' });
      expect(input.listeners('data')).toContain(owner);
    } finally { input.destroy(); }
  });

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
