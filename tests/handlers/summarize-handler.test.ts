/**
 * Tests for Summarize Handler - Stop hook transcript resilience (#1274)
 *
 * Validates:
 * - Handler degrades gracefully when transcript file is missing (context compaction)
 * - Handler degrades gracefully when transcript file is empty
 * - Handler still sends summary request to worker even without transcript content
 * - Handler succeeds normally when transcript is present
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';

// Track warn calls for assertion
const warnCalls: any[][] = [];
const noopFn = () => {};

// Mock logger to avoid issues with other test files' mock pollution
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: noopFn,
    debug: noopFn,
    warn: (...args: any[]) => { warnCalls.push(args); },
    error: noopFn,
    dataIn: noopFn,
    dataOut: noopFn,
    failure: noopFn,
  },
}));

// Mock worker-utils to avoid actual network calls
let lastSummarizeBody: any = null;
mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 99999,
  fetchWithTimeout: (_url: string, options: any) => {
    lastSummarizeBody = JSON.parse(options.body);
    return Promise.resolve({ ok: true });
  },
}));

// Import after mocks
import { summarizeHandler } from '../../src/cli/handlers/summarize.js';

let testDir: string;

describe('Summarize Handler - Transcript Resilience (#1274)', () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `summarize-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    lastSummarizeBody = null;
    warnCalls.length = 0;
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('should not crash when transcript file does not exist (#1274)', async () => {
    const result = await summarizeHandler.execute({
      sessionId: 'test-session-1274',
      cwd: '/tmp',
      transcriptPath: '/nonexistent/path/transcript.jsonl',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    // Should still send request to worker with empty message
    expect(lastSummarizeBody).not.toBeNull();
    expect(lastSummarizeBody.contentSessionId).toBe('test-session-1274');
    expect(lastSummarizeBody.last_assistant_message).toBe('');
  });

  it('should log warning when transcript is unavailable (#1274)', async () => {
    await summarizeHandler.execute({
      sessionId: 'test-session-warn',
      cwd: '/tmp',
      transcriptPath: '/nonexistent/transcript.jsonl',
    });

    const transcriptWarning = warnCalls.find(
      (call: any[]) => String(call[1]).includes('Transcript unavailable')
    );
    expect(transcriptWarning).toBeDefined();
  });

  it('should not crash when transcript file is empty (#1274)', async () => {
    const emptyFile = join(testDir, 'empty-transcript.jsonl');
    writeFileSync(emptyFile, '');

    const result = await summarizeHandler.execute({
      sessionId: 'test-session-empty',
      cwd: '/tmp',
      transcriptPath: emptyFile,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(lastSummarizeBody.last_assistant_message).toBe('');
  });

  it('should succeed normally with valid transcript', async () => {
    const transcriptFile = join(testDir, 'valid-transcript.jsonl');
    const transcriptLine = JSON.stringify({
      type: 'assistant',
      message: { content: 'I fixed the bug in auth.ts' },
    });
    writeFileSync(transcriptFile, transcriptLine);

    const result = await summarizeHandler.execute({
      sessionId: 'test-session-valid',
      cwd: '/tmp',
      transcriptPath: transcriptFile,
    });

    expect(result.continue).toBe(true);
    expect(lastSummarizeBody.last_assistant_message).toBe('I fixed the bug in auth.ts');
  });

  it('should skip gracefully when no transcriptPath provided', async () => {
    const result = await summarizeHandler.execute({
      sessionId: 'test-session-no-path',
      cwd: '/tmp',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    // Should NOT have sent request to worker
    expect(lastSummarizeBody).toBeNull();
  });
});
