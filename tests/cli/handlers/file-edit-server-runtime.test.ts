import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

// Settings the handler sees via loadFromFileOnce() (shouldTrackProject).
let mockSettings: Record<string, string> = { CLAUDE_MEM_EXCLUDED_PROJECTS: '' };
mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => mockSettings,
}));

// file-edit spools and nudges; it must never await the worker. Any awaited
// worker call is a regression.
const awaitedWorkerCallLog: Array<{ path: string; method: string; body: unknown }> = [];
const nudgeLog: string[] = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: (path: string, method: string, body: unknown) => {
    awaitedWorkerCallLog.push({ path, method, body });
    return Promise.resolve({ status: 'queued' });
  },
  ensureWorkerRunning: () => Promise.resolve(true),
  workerHttpRequest: (path: string) => {
    nudgeLog.push(path);
    return Promise.resolve(new Response('{"status":"draining"}', { status: 202 }));
  },
}));

// Mutable runtime context so individual cases flip between the `worker` and
// `server` runtimes. In server runtime the file edit must reach the server
// (recordEvent), never the local worker spool.
const recordEventLog: Array<Record<string, unknown>> = [];
let mockRuntime: Record<string, unknown> = { runtime: 'worker' };
const serverRuntime = () => ({
  runtime: 'server',
  projectId: 'proj-test',
  serverBaseUrl: 'http://127.0.0.1:0',
  client: {
    recordEvent: (evt: Record<string, unknown>) => {
      recordEventLog.push(evt);
      return Promise.resolve();
    },
  },
});
mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => mockRuntime,
  logServerFallback: () => {},
}));

import { logger } from '../../../src/utils/logger.js';
import { ServerClient, ServerClientError } from '../../../src/services/hooks/server-client.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  awaitedWorkerCallLog.length = 0;
  nudgeLog.length = 0;
  recordEventLog.length = 0;
  mockRuntime = { runtime: 'worker' };
  mockSettings = { CLAUDE_MEM_EXCLUDED_PROJECTS: '' };
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  tempSpool.restore();
});

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

const cursorInput = () => ({
  sessionId: 'cursor-session-1',
  cwd: '/tmp/file-edit-server-project',
  platform: 'Cursor',
  filePath: '/tmp/file-edit-server-project/a.ts',
  edits: [{ oldText: 'before', newText: 'after' }],
});

describe('fileEditHandler — server runtime (data-loss fix)', () => {
  it('records the file edit on the server instead of spooling to a local worker', async () => {
    mockRuntime = serverRuntime();
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute(cursorInput());

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    // The edit reached the server, not the local spool.
    expect(recordEventLog).toHaveLength(1);
    expect(spooledEntries()).toEqual([]);
    expect(nudgeLog).toEqual([]);
    expect(awaitedWorkerCallLog).toEqual([]);

    const event = recordEventLog[0];
    expect(event.projectId).toBe('proj-test');
    expect(event.contentSessionId).toBe('cursor-session-1');
    expect(event.platformSource).toBe('cursor');
    expect(event.sourceType).toBe('hook');
    expect(event.eventType).toBe('tool_use');
    expect(event.payload).toMatchObject({
      tool_name: 'write_file',
      tool_input: { filePath: '/tmp/file-edit-server-project/a.ts', edits: [{ oldText: 'before', newText: 'after' }] },
      tool_response: { success: true },
      cwd: '/tmp/file-edit-server-project',
      platformSource: 'cursor',
    });
  });

  it('still spools the file edit on the worker runtime (no behavior change)', async () => {
    mockRuntime = { runtime: 'worker' };
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute(cursorInput());

    expect(result.continue).toBe(true);
    expect(recordEventLog).toHaveLength(0);
    expect(nudgeLog).toEqual(['/api/spool/nudge']);
    expect(spooledEntries('file_edit')).toHaveLength(1);
  });

  it('honors CLAUDE_MEM_SKIP_TOOLS in server runtime: an excluded edit never reaches the server', async () => {
    mockRuntime = serverRuntime();
    mockSettings = { CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_SKIP_TOOLS: 'TodoWrite, Write_File ' };
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute(cursorInput());

    expect(result.continue).toBe(true);
    expect(recordEventLog).toHaveLength(0);
    expect(spooledEntries()).toEqual([]);
  });

  it('falls back to the worker spool when the server call is fallback-eligible', async () => {
    const fallbackError = new ServerClientError('transport', 'transport down');
    mockRuntime = {
      runtime: 'server',
      projectId: 'proj-test',
      serverBaseUrl: 'http://127.0.0.1:0',
      client: { recordEvent: () => Promise.reject(fallbackError) },
    };
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute(cursorInput());

    expect(result.continue).toBe(true);
    expect(spooledEntries('file_edit')).toHaveLength(1);
  });

  it('does not spool when the server call is a non-recoverable client error', async () => {
    const hardError = new ServerClientError('http_error', 'bad request', { status: 400 });
    mockRuntime = {
      runtime: 'server',
      projectId: 'proj-test',
      serverBaseUrl: 'http://127.0.0.1:0',
      client: { recordEvent: () => Promise.reject(hardError) },
    };
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute(cursorInput());

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(spooledEntries()).toEqual([]);
  });

  it('strips <private> sections from the edit before the event leaves the hook (outgoing HTTP body)', async () => {
    const outgoingBodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
      outgoingBodies.push(String(init.body));
      return new Response(JSON.stringify({ event: { id: 'evt-1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    try {
      mockRuntime = {
        runtime: 'server',
        projectId: 'proj-test',
        serverBaseUrl: 'http://127.0.0.1:0',
        client: new ServerClient({ serverBaseUrl: 'http://127.0.0.1:0', apiKey: 'test-key' }),
      };
      const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

      await fileEditHandler.execute({
        ...cursorInput(),
        edits: [{ oldText: 'const a = 1;', newText: 'const a = 2; <private>confidential text</private>' }],
      });

      expect(outgoingBodies).toHaveLength(1);
      expect(outgoingBodies[0]).not.toContain('confidential text');
      expect(outgoingBodies[0]).not.toContain('<private>');
      const body = JSON.parse(outgoingBodies[0]);
      expect(body.payload.tool_input.edits).toEqual([{ oldText: 'const a = 1;', newText: 'const a = 2;' }]);
      expect(spooledEntries()).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
