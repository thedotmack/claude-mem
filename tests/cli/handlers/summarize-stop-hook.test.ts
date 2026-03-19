/**
 * Summarize Handler Error Resilience Tests
 *
 * Verifies that the summarize handler never throws — it always returns gracefully.
 *
 * Mock Justification:
 * - worker-utils: Controls whether worker is running and HTTP responses
 * - transcript-parser: Controls message extraction behavior and failure modes
 * - logger: Suppresses console output during tests
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';
import { HOOK_EXIT_CODES } from '../../../src/shared/hook-constants.js';

// --- Module-level mocks (must be before handler import) ---

const mockEnsureWorkerRunning = mock(() => Promise.resolve(true));
const mockWorkerHttpRequest = mock(() => Promise.resolve({ ok: true, status: 200 }));

mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: mockEnsureWorkerRunning,
  workerHttpRequest: mockWorkerHttpRequest,
}));

const mockExtractLastMessage = mock(() => 'Last assistant message content');

mock.module('../../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: mockExtractLastMessage,
}));

import { summarizeHandler } from '../../../src/cli/handlers/summarize.js';

// --- Test suite ---

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('Summarize handler error resilience', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
      spyOn(logger, 'dataIn').mockImplementation(() => {}),
    ];

    // Reset mocks to defaults
    mockEnsureWorkerRunning.mockImplementation(() => Promise.resolve(true));
    mockWorkerHttpRequest.mockImplementation(() => Promise.resolve({ ok: true, status: 200 }));
    mockExtractLastMessage.mockImplementation(() => 'Last assistant message content');
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('returns exitCode 0 when worker is not running', async () => {
    mockEnsureWorkerRunning.mockImplementation(() => Promise.resolve(false));

    const result = await summarizeHandler.execute({
      sessionId: 'test-session-123',
      transcriptPath: '/tmp/test-transcript.jsonl',
      hookEvent: 'summarize',
      platform: 'claude-code',
      promptNumber: 1,
    });

    expect(result).toEqual({
      continue: true,
      suppressOutput: true,
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    });
  });

  it('returns exitCode 0 when transcriptPath is missing', async () => {
    const result = await summarizeHandler.execute({
      sessionId: 'test-session-123',
      transcriptPath: undefined as any,
      hookEvent: 'summarize',
      platform: 'claude-code',
      promptNumber: 1,
    });

    expect(result).toEqual({
      continue: true,
      suppressOutput: true,
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    });
  });

  it('does not throw when extractLastMessage throws SyntaxError', async () => {
    mockExtractLastMessage.mockImplementation(() => { throw new SyntaxError('Unexpected token'); });

    const result = await summarizeHandler.execute({
      sessionId: 'test-session-123',
      transcriptPath: '/tmp/test-transcript.jsonl',
      hookEvent: 'summarize',
      platform: 'claude-code',
      promptNumber: 1,
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  it('does not throw when workerHttpRequest throws ECONNREFUSED', async () => {
    mockWorkerHttpRequest.mockImplementation(() => { throw new Error('ECONNREFUSED'); });

    const result = await summarizeHandler.execute({
      sessionId: 'test-session-123',
      transcriptPath: '/tmp/test-transcript.jsonl',
      hookEvent: 'summarize',
      platform: 'claude-code',
      promptNumber: 1,
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  it('does not throw when worker returns non-ok response', async () => {
    mockWorkerHttpRequest.mockImplementation(() => Promise.resolve({ ok: false, status: 500 }));

    const result = await summarizeHandler.execute({
      sessionId: 'test-session-123',
      transcriptPath: '/tmp/test-transcript.jsonl',
      hookEvent: 'summarize',
      platform: 'claude-code',
      promptNumber: 1,
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  it('returns successfully on happy path', async () => {
    const result = await summarizeHandler.execute({
      sessionId: 'test-session-123',
      transcriptPath: '/tmp/test-transcript.jsonl',
      hookEvent: 'summarize',
      platform: 'claude-code',
      promptNumber: 1,
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
  });
});
