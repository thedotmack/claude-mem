import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractPriorMessages } from '../../src/services/context/ObservationCompiler.js';
import { TRANSCRIPT_TAIL_INITIAL_BYTES } from '../../src/shared/transcript-parser.js';

function assistant(text: string) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

function fixture(run: (path: string) => void) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'claude-mem-prior-tail-'));
  try { run(join(directory, 'session.jsonl')); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe('prior-session transcript reads', () => {
  it('reads only a tail window when the last reply is at the end of a long session', () => fixture(path => {
    const oldTool = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(8192) } });
    fs.writeFileSync(path, `${Array(300).fill(oldTool).join('\n')}\n${assistant('Final answer')}\n`);
    const size = fs.statSync(path).size;
    const readFile = fs.readFileSync;
    const open = fs.openSync;
    const read = fs.readSync;
    const close = fs.closeSync;
    const descriptors = new Set<number>();
    let bytesRead = 0;
    const wholeFileSpy = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      const result = (readFile as any)(file, ...args);
      if (String(file) === path) bytesRead += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
      return result;
    }) as any);
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
      const fd = (open as any)(file, ...args);
      if (String(file) === path) descriptors.add(fd);
      return fd;
    }) as any);
    const readSpy = spyOn(fs, 'readSync').mockImplementation(((fd: number, ...args: any[]) => {
      const count = (read as any)(fd, ...args);
      if (descriptors.has(fd)) bytesRead += count;
      return count;
    }) as any);
    const closeSpy = spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      descriptors.delete(fd);
      return close(fd);
    });
    try {
      expect(extractPriorMessages(path)).toEqual({ assistantMessage: 'Final answer' });
      expect(bytesRead).toBeGreaterThan(0);
      expect(bytesRead).toBeLessThan(size / 2);
      expect(descriptors.size).toBe(0);
    } finally {
      closeSpy.mockRestore(); readSpy.mockRestore(); openSpy.mockRestore(); wholeFileSpy.mockRestore();
    }
  }));

  it('joins a large UTF-8 assistant entry across a chunk boundary without losing text', () => fixture(path => {
    const text = 'A useful reply: ' + '知識🙂'.repeat(40_000);
    fs.writeFileSync(path, `${assistant('Older answer')}\n${assistant(text)}\n`);
    expect(fs.statSync(path).size).toBeGreaterThan(TRANSCRIPT_TAIL_INITIAL_BYTES);
    expect(extractPriorMessages(path).assistantMessage).toBe(text);
  }));

  it('continues past tool-only, reminder-only and malformed trailing entries', () => fixture(path => {
    const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } });
    fs.writeFileSync(path, [assistant('Keep this reply'), tool,
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(TRANSCRIPT_TAIL_INITIAL_BYTES + 500) } }),
      assistant('<system-reminder>Internal reminder</system-reminder>'), '{"type":"assistant",', '',
    ].join('\n'));
    expect(extractPriorMessages(path).assistantMessage).toBe('Keep this reply');
  }));

  it('keeps the existing empty result for missing files and transcripts without text replies', () => fixture(path => {
    expect(extractPriorMessages(path)).toEqual({ assistantMessage: '' });
    fs.writeFileSync(path, '{"type":"user","message":{"content":"hello"}}\n');
    expect(extractPriorMessages(path)).toEqual({ assistantMessage: '' });
  }));
});
