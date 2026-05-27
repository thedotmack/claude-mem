
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LogsRoutes, readLastLines } from '../../src/services/worker/http/routes/LogsRoutes.js';

describe('readLastLines (#1203 OOM fix)', () => {
  const testDir = join(tmpdir(), `claude-mem-logs-test-${Date.now()}`);
  const testFile = join(testDir, 'test.log');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty string for empty file', () => {
    writeFileSync(testFile, '', 'utf-8');
    const result = readLastLines(testFile, 10);
    expect(result.lines).toBe('');
    expect(result.totalEstimate).toBe(0);
  });

  it('should return all lines when file has fewer lines than requested', () => {
    writeFileSync(testFile, 'line1\nline2\nline3\n', 'utf-8');
    const result = readLastLines(testFile, 10);
    expect(result.lines).toBe('line1\nline2\nline3');
    expect(result.totalEstimate).toBe(3);
  });

  it('should return exactly the last N lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    writeFileSync(testFile, lines.join('\n') + '\n', 'utf-8');

    const result = readLastLines(testFile, 5);
    expect(result.lines).toBe('line16\nline17\nline18\nline19\nline20');
  });

  it('should return single line when requested', () => {
    writeFileSync(testFile, 'first\nsecond\nthird\n', 'utf-8');
    const result = readLastLines(testFile, 1);
    expect(result.lines).toBe('third');
  });

  it('should handle file without trailing newline', () => {
    writeFileSync(testFile, 'line1\nline2\nline3', 'utf-8');
    const result = readLastLines(testFile, 2);
    expect(result.lines).toBe('line2\nline3');
  });

  it('should handle single line file', () => {
    writeFileSync(testFile, 'only line\n', 'utf-8');
    const result = readLastLines(testFile, 5);
    expect(result.lines).toBe('only line');
    expect(result.totalEstimate).toBe(1);
  });

  it('should handle file with exactly requested number of lines', () => {
    writeFileSync(testFile, 'a\nb\nc\n', 'utf-8');
    const result = readLastLines(testFile, 3);
    expect(result.lines).toBe('a\nb\nc');
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

  it('should provide accurate totalEstimate when entire file is read', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i}`);
    writeFileSync(testFile, lines.join('\n') + '\n', 'utf-8');

    const result = readLastLines(testFile, 100);
    expect(result.totalEstimate).toBe(5);
  });

  it('should handle requesting zero lines', () => {
    writeFileSync(testFile, 'line1\nline2\n', 'utf-8');
    const result = readLastLines(testFile, 0);
    expect(result.lines).toBe('');
  });

  it('should handle file with only newlines', () => {
    writeFileSync(testFile, '\n\n\n', 'utf-8');
    const result = readLastLines(testFile, 2);
    const resultLines = result.lines.split('\n');
    expect(resultLines.length).toBe(2);
  });

  it('should not load entire large file for small tail request', () => {
    const line = 'A'.repeat(100) + '\n'; 
    const lineCount = 1000; 
    writeFileSync(testFile, line.repeat(lineCount), 'utf-8');

    const result = readLastLines(testFile, 5);
    const resultLines = result.lines.split('\n');
    expect(resultLines.length).toBe(5);
    for (const l of resultLines) {
      expect(l).toBe('A'.repeat(100));
    }
  });
});

describe('/api/logs/clear', () => {
  let testDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `claude-mem-clear-logs-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = testDir;
    mkdirSync(join(testDir, 'logs'), { recursive: true });
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('accepts an empty POST body and removes existing log content', () => {
    const date = new Date().toISOString().split('T')[0];
    const logFile = join(testDir, 'logs', `claude-mem-${date}.log`);
    writeFileSync(logFile, 'line1\nline2\n', 'utf-8');

    const clearHandlers: Array<(req: any, res: any, next: () => void) => void> = [];
    const app = {
      get: () => {},
      post: (path: string, ...handlers: Array<(req: any, res: any, next: () => void) => void>) => {
        if (path === '/api/logs/clear') {
          clearHandlers.push(...handlers);
        }
      },
    };

    new LogsRoutes().setupRoutes(app as any);

    let statusCode = 200;
    let responseBody: unknown;
    const response = {
      status: (code: number) => {
        statusCode = code;
        return response;
      },
      json: (body: unknown) => {
        responseBody = body;
        return response;
      },
    };

    const request = { body: undefined, path: '/api/logs/clear' };
    for (const handler of clearHandlers) {
      let nextCalled = false;
      handler(request, response, () => {
        nextCalled = true;
      });

      if (!nextCalled) {
        break;
      }
    }

    expect(statusCode).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      message: 'Log file cleared',
      path: logFile,
    });

    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).not.toContain('line1');
    expect(logContent).not.toContain('line2');
  });
});
