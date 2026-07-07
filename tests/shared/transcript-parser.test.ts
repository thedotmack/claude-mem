import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { countTranscriptLines } from '../../src/shared/transcript-parser.js';

describe('countTranscriptLines', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function writeTranscript(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'claude-mem-transcript-test-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('counts non-empty JSONL lines', () => {
    const path = writeTranscript('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(countTranscriptLines(path)).toBe(3);
  });

  it('ignores blank lines', () => {
    const path = writeTranscript('{"a":1}\n\n{"a":2}\n\n\n');
    expect(countTranscriptLines(path)).toBe(2);
  });

  it('returns 0 for a missing file', () => {
    expect(countTranscriptLines('/nonexistent/path/transcript.jsonl')).toBe(0);
  });

  it('returns 0 for an empty file', () => {
    const path = writeTranscript('');
    expect(countTranscriptLines(path)).toBe(0);
  });

  it('returns 0 for an empty path', () => {
    expect(countTranscriptLines('')).toBe(0);
  });
});
