import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';

const source = readFileSync(join(import.meta.dir, '..', 'plugin/scripts/bun-runner.js'), 'utf8');
const body = source.slice(source.indexOf('function collectStdin('), source.indexOf('\nconst stdinData ='));
const collectStdin = new Function(`${body}\nreturn collectStdin;`)() as
  (input: PassThrough, options?: { json?: boolean; timeoutMs?: number }) => Promise<Buffer | null>;

describe('bun-runner hook stdin framing', () => {
  it('accepts a complete hook object without EOF and removes only its listeners', async () => {
    const input = new PassThrough();
    const externalErrorListener = () => {};
    input.on('error', externalErrorListener);
    const result = collectStdin(input, { json: true, timeoutMs: 3000 });
    const payload = Buffer.from('{"session_id":"fixture","prompt":"hello"}');
    input.write(payload);
    const received = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('still waiting'), 500))]);
    expect(received).toEqual(payload);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listeners('error')).toEqual([externalErrorListener]);
    input.destroy();
  });

  it('waits for fragmented JSON, preserving UTF-8 bytes', async () => {
    const input = new PassThrough();
    const payload = Buffer.from('{"prompt":"Gr\u00fc\u00dfe"}');
    let complete = false;
    const result = collectStdin(input, { json: true }).then(value => { complete = true; return value; });
    const split = payload.indexOf(Buffer.from('\u00fc')) + 1;
    input.write(payload.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(complete).toBe(false);
    input.write(payload.subarray(split));
    expect(await result).toEqual(payload);
    input.destroy();
  });

  it('preserves EOF framing for non-hook commands', async () => {
    const input = new PassThrough();
    let complete = false;
    const result = collectStdin(input).then(value => { complete = true; return value; });
    input.write('{}');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(complete).toBe(false);
    input.end(' trailing input');
    expect((await result)!.toString()).toBe('{} trailing input');
  });

  it('retains partial input on the bounded timeout for downstream diagnostics', async () => {
    const input = new PassThrough();
    const result = collectStdin(input, { json: true, timeoutMs: 20 });
    input.write('{"partial":');
    expect((await result)!.toString()).toBe('{"partial":');
    input.destroy();
  });

  it('returns null on empty EOF', async () => {
    const input = new PassThrough();
    const result = collectStdin(input, { json: true });
    input.end();
    expect(await result).toBeNull();
  });
});
