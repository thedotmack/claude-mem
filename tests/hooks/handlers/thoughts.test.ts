import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../../src/utils/logger.js';

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
const { handleThoughtsExtraction } = await import('../../../src/hooks/handlers/thoughts.js');

const TEST_DIR = join(tmpdir(), 'thoughts-handler-test-' + process.pid);

function makeTranscriptLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function writeTranscript(filename: string, lines: string[]): string {
  const filepath = join(TEST_DIR, filename);
  writeFileSync(filepath, lines.join('\n'), 'utf-8');
  return filepath;
}

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('handleThoughtsExtraction', () => {
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

  it('returns 0 when transcript has no thinking blocks', async () => {
    const transcript = writeTranscript('no-thinking.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: { content: [{ type: 'text', text: 'Just text' }] },
      }),
    ]);

    const result = await handleThoughtsExtraction({
      transcriptPath: transcript,
      sessionId: 'test-session',
      memorySessionId: 'mem-session',
      project: 'test-project',
    });

    expect(result.thoughtsStored).toBe(0);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('returns 0 when transcript file does not exist', async () => {
    const result = await handleThoughtsExtraction({
      transcriptPath: '/nonexistent/path.jsonl',
      sessionId: 'test-session',
      memorySessionId: 'mem-session',
      project: 'test-project',
    });

    expect(result.thoughtsStored).toBe(0);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('extracts and stores thinking blocks via worker API', async () => {
    mockFetchWithTimeout.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ids: [10, 20] }), { status: 200 }))
    );

    const transcript = writeTranscript('with-thinking.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'First thought' },
            { type: 'text', text: 'Response 1' },
          ],
        },
      }),
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:01:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'Second thought' },
            { type: 'text', text: 'Response 2' },
          ],
        },
      }),
    ]);

    const result = await handleThoughtsExtraction({
      transcriptPath: transcript,
      sessionId: 'content-123',
      memorySessionId: 'mem-456',
      project: 'my-project',
    });

    expect(result.thoughtsStored).toBe(2);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetchWithTimeout.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:37777/api/sessions/thoughts');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body as string);
    expect(body.memorySessionId).toBe('mem-456');
    expect(body.contentSessionId).toBe('content-123');
    expect(body.project).toBe('my-project');
    expect(body.thoughts).toHaveLength(2);
    expect(body.thoughts[0].thinking_text).toBe('First thought');
    expect(body.thoughts[0].thinking_summary).toBeNull();
    expect(body.thoughts[0].message_index).toBe(0);
    expect(body.thoughts[1].thinking_text).toBe('Second thought');
    expect(body.thoughts[1].message_index).toBe(1);
  });

  it('returns 0 when worker is not available', async () => {
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

    const result = await handleThoughtsExtraction({
      transcriptPath: transcript,
      sessionId: 'test-session',
      memorySessionId: 'mem-session',
      project: 'test-project',
    });

    expect(result.thoughtsStored).toBe(0);
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('returns 0 when API returns non-ok response', async () => {
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

    const result = await handleThoughtsExtraction({
      transcriptPath: transcript,
      sessionId: 'test-session',
      memorySessionId: 'mem-session',
      project: 'test-project',
    });

    expect(result.thoughtsStored).toBe(0);
  });
});
