import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractAdvisorCalls, readTranscriptTail } from '../../src/shared/advisor-transcript.js';
import { extractTranscriptFileActivity } from '../../src/shared/deliverables-transcript.js';

const dirs: string[] = [];

afterEach(() => {
  mock.restore();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(content: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'transcript-short-read-'));
  dirs.push(dir);
  const path = join(dir, 'transcript.jsonl');
  fs.writeFileSync(path, content);
  return path;
}

function limitReads(bytes: number): void {
  const read = fs.readSync;
  spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    read(fd, buffer, offset, Math.min(length, bytes), position)) as typeof fs.readSync);
}

describe('transcript tail short reads', () => {
  it('fills the bounded buffer across short reads before decoding UTF-8', () => {
    const text = 'first\n日本語 and 🚀\nlast';
    const path = transcript(text);
    limitReads(2);
    expect(readTranscriptTail(path, 1024)).toEqual({ text, startOffset: 0 });
  });

  it('retains an exact line boundary and its byte offset across short reads', () => {
    const prefix = 'earlier 日本語\n';
    const text = 'first complete line\nlast 🚀\n';
    const path = transcript(prefix + text);
    limitReads(3);
    expect(readTranscriptTail(path, Buffer.byteLength(text))).toEqual({
      text, startOffset: Buffer.byteLength(prefix),
    });
  });

  it('discards only the partial first line after filling the tail', () => {
    const prefix = 'an earlier line\n';
    const text = 'complete 日本語\nlast\n';
    const path = transcript(prefix + text);
    limitReads(2);
    expect(readTranscriptTail(path, Buffer.byteLength(text) + 4)).toEqual({
      text, startOffset: Buffer.byteLength(prefix),
    });
  });

  it('does not append zero bytes if the file shrinks between stat and read', () => {
    const text = '{"complete":"日本語"}';
    const path = transcript(text + '\nremoved');
    const read = fs.readSync;
    let firstRead = true;
    spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (firstRead) {
        firstRead = false;
        fs.truncateSync(path, Buffer.byteLength(text));
      }
      return read(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    expect(readTranscriptTail(path, 1024)).toEqual({ text, startOffset: 0 });
  });

  it('keeps the empty-file behavior', () => {
    expect(readTranscriptTail(transcript(''), 1024)).toEqual({ text: '', startOffset: 0 });
  });

  it('captures complete advisor results and their original offsets after short reads', () => {
    const user = JSON.stringify({ type: 'user', message: { content: 'Explain 日本語' } });
    const call = JSON.stringify({ type: 'assistant', timestamp: '2026-07-06T05:00:01.000Z', message: {
      content: [{ type: 'server_tool_use', id: 'srvtoolu_short', name: 'advisor' }],
    } });
    const result = JSON.stringify({ type: 'assistant', message: { content: [{
      type: 'advisor_tool_result', tool_use_id: 'srvtoolu_short',
      content: { type: 'advisor_result', text: 'Complete advice 🚀' },
    }] } });
    const path = transcript([user, call, result].join('\n'));
    limitReads(7);
    const calls = extractAdvisorCalls(path, { currentTurnOnly: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].advice).toBe('Complete advice 🚀');
    expect(calls[0].lastUserMessage).toBe('Explain 日本語');
    expect(calls[0].transcriptByteOffset).toBe(Buffer.byteLength(user) + 1);
  });

  it('retains confirmed deliverables and the originating privacy scope after short reads', () => {
    const path = transcript([
      { type: 'user', message: { content: '<private>Create the report</private>' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/w/report.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write', content: 'ok' }] } },
    ].map(line => JSON.stringify(line)).join('\n'));
    limitReads(11);
    const activity = extractTranscriptFileActivity(path);
    expect(activity.writes.map(write => write.path)).toEqual(['/w/report.md']);
    expect(activity.promptSeen).toBe(true);
    expect(activity.privateTurn).toBe(true);
  });
});
