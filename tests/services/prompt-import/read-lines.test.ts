import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLines } from '../../../src/services/prompt-import/readers.js';

const directories: string[] = [];
function fixture(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'prompt-lines-'));
  directories.push(directory);
  const path = join(directory, 'transcript.jsonl');
  writeFileSync(path, content);
  return path;
}

async function lines(path: string): Promise<string[]> {
  const result: string[] = [];
  for await (const line of readLines(path)) result.push(line);
  return result;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('streamed prompt-import lines', () => {
  it.each([
    ['', []],
    ['\n', ['']],
    ['\nfirst\r\n\nlast\n', ['', 'first\r', '', 'last']],
    ['first\nlast', ['first', 'last']],
  ] as [string, string[]][])('preserves line endings and empty records in %j', async (content, expected) => {
    expect(await lines(fixture(content))).toEqual(expected);
  });

  it('keeps a large tool record whole between small records', async () => {
    const payload = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(3 * 1024 * 1024 + 13) } });
    const before = '{"type":"user","text":"before"}';
    const after = '{"type":"user","text":"after"}';
    expect(await lines(fixture(`${before}\n${payload}\n${after}`))).toEqual([before, payload, after]);
  });

  it('flushes a large unterminated final record once', async () => {
    const payload = 'x'.repeat(3 * 1024 * 1024 + 13);
    expect(await lines(fixture(payload))).toEqual([payload]);
  });

  it('preserves UTF-8 code points split across the read window', async () => {
    const payload = 'x'.repeat(1024 * 1024 - 1) + '🌲中文';
    expect(await lines(fixture(`${payload}\nnext\n`))).toEqual([payload, 'next']);
  });

  it('propagates source read errors instead of yielding an empty history', async () => {
    const path = fixture('');
    rmSync(path);
    await expect(lines(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
