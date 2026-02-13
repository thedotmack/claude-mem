import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../../src/utils/logger.js';
import { HOOK_EXIT_CODES } from '../../../src/shared/hook-constants.js';

// Mock worker-utils before importing the module under test
const mockFetchWithTimeout = mock(() => Promise.resolve(new Response(JSON.stringify({ ids: [1, 2, 3] }), { status: 200 })));
const mockGetWorkerPort = mock(() => 37777);
const mockEnsureWorkerRunning = mock(() => Promise.resolve(true));

mock.module('../../../src/shared/worker-utils.js', () => ({
  fetchWithTimeout: mockFetchWithTimeout,
  getWorkerPort: mockGetWorkerPort,
  ensureWorkerRunning: mockEnsureWorkerRunning,
}));

// Import after mocking
const { thoughtsExtractHandler } = await import('../../../src/cli/handlers/thoughts-extract.js');

const TEST_DIR = join(tmpdir(), 'thoughts-extract-handler-test-' + process.pid);

function makeTranscriptLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function writeTranscript(filename: string, lines: string[]): string {
  const filepath = join(TEST_DIR, filename);
  writeFileSync(filepath, lines.join('\n'), 'utf-8');
  return filepath;
}

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('thoughtsExtractHandler', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    mockFetchWithTimeout.mockReset();
    mockGetWorkerPort.mockReset();
    mockEnsureWorkerRunning.mockReset();
    mockFetchWithTimeout.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ids: [1, 2, 3] }), { status: 200 }))
    );
    mockGetWorkerPort.mockImplementation(() => 37777);
    mockEnsureWorkerRunning.mockImplementation(() => Promise.resolve(true));
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns success with suppressOutput when transcriptPath is missing', async () => {
    const result = await thoughtsExtractHandler.execute({
      sessionId: 'test-session',
      cwd: '/tmp',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('returns success with suppressOutput when sessionId is missing', async () => {
    const result = await thoughtsExtractHandler.execute({
      sessionId: '',
      cwd: '/tmp',
      transcriptPath: '/some/path.jsonl',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('extracts and stores thinking blocks successfully', async () => {
    mockFetchWithTimeout.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ids: [10, 20] }), { status: 200 }))
    );

    const transcript = writeTranscript('with-thinking.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'Deep thought' },
            { type: 'text', text: 'Response' },
          ],
        },
      }),
    ]);

    const result = await thoughtsExtractHandler.execute({
      sessionId: 'content-123',
      cwd: '/tmp',
      transcriptPath: transcript,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('returns success even when no thinking blocks found', async () => {
    const transcript = writeTranscript('no-thinking.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: { content: [{ type: 'text', text: 'Just text' }] },
      }),
    ]);

    const result = await thoughtsExtractHandler.execute({
      sessionId: 'test-session',
      cwd: '/tmp',
      transcriptPath: transcript,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('returns success even when worker is unavailable (graceful degradation)', async () => {
    mockEnsureWorkerRunning.mockImplementation(() => Promise.resolve(false));

    const transcript = writeTranscript('worker-down.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {
          content: [{ type: 'thinking', thinking: 'A thought' }],
        },
      }),
    ]);

    const result = await thoughtsExtractHandler.execute({
      sessionId: 'test-session',
      cwd: '/tmp',
      transcriptPath: transcript,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('returns success even when extraction throws an error', async () => {
    // Use a non-existent transcript path to trigger an error in extractThinkingBlocks
    const result = await thoughtsExtractHandler.execute({
      sessionId: 'test-session',
      cwd: '/tmp',
      transcriptPath: '/nonexistent/path.jsonl',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('always exits with code 0 regardless of errors', async () => {
    mockFetchWithTimeout.mockImplementation(() =>
      Promise.resolve(new Response('Internal Server Error', { status: 500 }))
    );

    const transcript = writeTranscript('api-error.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {
          content: [{ type: 'thinking', thinking: 'A thought' }],
        },
      }),
    ]);

    const result = await thoughtsExtractHandler.execute({
      sessionId: 'test-session',
      cwd: '/tmp',
      transcriptPath: transcript,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });
});
