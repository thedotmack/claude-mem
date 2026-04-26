// Tests for readJsonFromStdin's onEnd contract (#2089).
//
// The previous implementation silently dropped malformed JSON when stdin
// closed, returning undefined just like the empty-input case. The fix mirrors
// the safety-timeout path: non-empty + unparseable = reject.

import { describe, it, expect, afterEach } from 'bun:test';
import { Readable } from 'stream';

import { readJsonFromStdin } from '../../src/cli/stdin-reader.js';

const realStdin = process.stdin;
const realStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

function installFakeStdin(payload: string): void {
  // Build a Readable that emits the payload, then ends — matches the
  // shape of a process.stdin pipe closing after a single write.
  const fake = Readable.from([payload], { objectMode: false }) as unknown as NodeJS.ReadStream;
  // The reader checks isTTY (must be falsy) and `.readable` access.
  Object.defineProperty(fake, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: realStdinDescriptor?.enumerable ?? true,
    writable: true,
    value: fake,
  });
}

afterEach(() => {
  if (realStdinDescriptor) {
    Object.defineProperty(process, 'stdin', realStdinDescriptor);
  } else {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
  }
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
