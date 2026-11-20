
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readLastLines } from '../../src/services/worker/http/routes/LogsRoutes.js';

describe('readLastLines (#1203 OOM fix)', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'claude-mem-logs-test-'));
    testFile = join(testDir, 'test.log');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it.each([
    ['empty file', '', 10, '', 0],
    ['fewer lines than requested', 'line1\nline2\nline3\n', 10, 'line1\nline2\nline3', 3],
    ['last N lines', Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n', 5, 'line16\nline17\nline18\nline19\nline20', 20],
    ['single line requested', 'first\nsecond\nthird\n', 1, 'third', 3],
    ['no trailing newline', 'line1\nline2\nline3', 2, 'line2\nline3', 3],
    ['single line file', 'only line\n', 5, 'only line', 1],
    ['exactly requested line count', 'a\nb\nc\n', 3, 'a\nb\nc', 3],
    ['whole-file estimate', Array.from({ length: 5 }, (_, i) => `line${i}`).join('\n') + '\n', 100, 'line0\nline1\nline2\nline3\nline4', 5],
    ['zero lines requested', 'line1\nline2\n', 0, '', 2],
    ['only newlines', '\n\n\n', 2, '\n', 3],
  ] as const)('reads %s', (_name, content, lineCount, lines, totalEstimate) => {
    writeFileSync(testFile, content, 'utf-8');
    expect(readLastLines(testFile, lineCount)).toEqual({ lines, totalEstimate });
  });

  it('should work with lines larger than initial chunk size', () => {
    const longLine = 'X'.repeat(10000);
    const lines = Array.from({ length: 20 }, (_, i) => `${i}:${longLine}`);
    writeFileSync(testFile, lines.join('\n') + '\n', 'utf-8');

    const result = readLastLines(testFile, 3);
    const resultLines = result.lines.split('\n');
    expect(resultLines.length).toBe(3);
    expect(resultLines[0]).toStartWith('17:');
    expect(resultLines[1]).toStartWith('18:');
    expect(resultLines[2]).toStartWith('19:');
  });

  it('returns complete newline-terminated lines crossing the initial chunk boundary', () => {
    const lastLine = 'last:' + 'X'.repeat(70000);
    writeFileSync(testFile, 'first\n' + lastLine + '\n', 'utf-8');
    expect(readLastLines(testFile, 1).lines).toBe(lastLine);
  });

  it('returns complete unterminated lines crossing the initial chunk boundary', () => {
    const lastLine = 'last:' + 'X'.repeat(70000);
    writeFileSync(testFile, 'first\n' + lastLine, 'utf-8');
    expect(readLastLines(testFile, 1).lines).toBe(lastLine);
  });

  it('estimates multibyte log lines in bytes when reading only the tail', () => {
    const line = '甲'.repeat(21); // 64 bytes including the newline
    writeFileSync(testFile, (line + '\n').repeat(2048));
    const result = readLastLines(testFile, 3);
    expect(result.lines).toBe([line, line, line].join('\n'));
    expect(result.totalEstimate).toBe(2048);
  });
});
