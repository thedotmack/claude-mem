import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const originalFetch = globalThis.fetch;
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
const originalNoMain = process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN;

describe('export-memories script', () => {
  let tempDir: string | undefined;
  const consoleSpies: ReturnType<typeof spyOn>[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;

    if (originalDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    }

    if (originalNoMain === undefined) {
      delete process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN;
    } else {
      process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN = originalNoMain;
    }

    consoleSpies.splice(0).forEach(spy => spy.mockRestore());

    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = undefined;

    mock.restore();
  });

  function setup(settings?: Record<string, unknown>): string {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-export-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN = '1';
    if (settings) writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings));
    consoleSpies.push(
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'warn').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
    );
    return tempDir;
  }

  it('loads settings from CLAUDE_MEM_DATA_DIR and sends canonical memorySessionIds', async () => {
    const tempDir = setup({
      CLAUDE_MEM_WORKER_PORT: '45678',
    });

    let batchBody: unknown;
    let searchSignal: unknown;
    let batchSignal: unknown;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:45678/api/search?')) {
        searchSignal = init?.signal;
        return new Response(JSON.stringify({
          observations: [
            { memory_session_id: 'memory-a' },
            { memory_session_id: 'memory-b' },
          ],
          sessions: [
            { memory_session_id: 'memory-a' },
          ],
          prompts: [],
        }), { status: 200 });
      }

      if (url === 'http://127.0.0.1:45678/api/sdk-sessions/batch') {
        batchSignal = init?.signal;
        batchBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify([
          { memory_session_id: 'memory-a' },
          { memory_session_id: 'memory-b' },
        ]), { status: 200 });
      }

      return new Response('unexpected url', { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { exportMemories } = await import('../../scripts/export-memories.ts');
    const outputFile = join(tempDir, 'export.json');

    await exportMemories('needle', outputFile, 'project-a');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(searchSignal).toBeInstanceOf(AbortSignal);
    expect(batchSignal).toBeInstanceOf(AbortSignal);
    expect(batchBody).toEqual({ memorySessionIds: ['memory-a', 'memory-b'] });
    expect(batchBody).not.toHaveProperty('sdkSessionIds');

    const exported = JSON.parse(readFileSync(outputFile, 'utf-8'));
    expect(exported.query).toBe('needle');
    expect(exported.project).toBe('project-a');
    expect(exported.totalSessions).toBe(2);
  });

  it('brackets an IPv6 worker host in the request URL', async () => {
    const tempDir = setup({
      CLAUDE_MEM_WORKER_HOST: '::1',
      CLAUDE_MEM_WORKER_PORT: '45678',
    });

    const requested: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('{}', { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { exportMemories } = await import('../../scripts/export-memories.ts');

    await expect(exportMemories('needle', join(tempDir, 'export.json'))).rejects.toThrow();
    expect(requested[0]).toStartWith('http://[::1]:45678/api/search?');
  });

  it.each([
    ['45678abc', 'Invalid CLAUDE_MEM_WORKER_PORT'],
    ['', 'Invalid CLAUDE_MEM_WORKER_PORT in settings.json: missing'],
    [45678, 'Invalid CLAUDE_MEM_WORKER_PORT in settings.json: missing'],
  ])('rejects worker port %p before fetching', async (port, error) => {
    const tempDir = setup({ CLAUDE_MEM_WORKER_PORT: port });
    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const { exportMemories } = await import('../../scripts/export-memories.ts');
    await expect(exportMemories('needle', join(tempDir, 'export.json'))).rejects.toThrow(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails the export when SDK session metadata cannot be fetched', async () => {
    const tempDir = setup({
      CLAUDE_MEM_WORKER_PORT: '45678',
    });

    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:45678/api/search?')) {
        return new Response(JSON.stringify({
          observations: [{ memory_session_id: 'memory-a' }],
          sessions: [],
          prompts: [],
        }), { status: 200 });
      }

      if (url === 'http://127.0.0.1:45678/api/sdk-sessions/batch') {
        return new Response('worker unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      }

      return new Response('unexpected url', { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { exportMemories } = await import('../../scripts/export-memories.ts');
    const outputFile = join(tempDir, 'export.json');

    await expect(exportMemories('needle', outputFile)).rejects.toThrow(
      'Failed to fetch SDK sessions: 503 Service Unavailable worker unavailable',
    );
    expect(existsSync(outputFile)).toBe(false);
  });

  it('keeps the request deadline active while reading the response body', async () => {
    const tempDir = setup();
    const output = join(tempDir, 'export.json');
    const originalTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, delay, ...args) =>
      originalTimeout(fn, delay === 30_000 ? 5 : delay, ...args)) as typeof setTimeout);
    try {
      globalThis.fetch = mock(async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          const finish = originalTimeout(() => controller.close(), 100);
          init!.signal!.addEventListener('abort', () => {
            clearTimeout(finish);
            controller.error(init!.signal!.reason);
          }, { once: true });
        }
      }))) as typeof fetch;
      const { exportMemories } = await import('../../scripts/export-memories.ts');
      await expect(exportMemories('needle', output)).rejects.toThrow('Worker request timed out');
      expect(existsSync(output)).toBe(false);
    } finally {
      timer.mockRestore();
    }
  });

  it('fails deterministically when a worker request times out', async () => {
    const tempDir = setup({
      CLAUDE_MEM_WORKER_PORT: '45678',
    });

    const fetchMock = mock(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { exportMemories } = await import('../../scripts/export-memories.ts');

    await expect(exportMemories('needle', join(tempDir, 'export.json'))).rejects.toThrow(
      'Worker request timed out after 30000ms',
    );
  });
});
