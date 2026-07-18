import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realTranscriptParser from '../../../src/shared/transcript-parser.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realTranscriptParserSnapshot = { ...realTranscriptParser };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

import { HOOK_EXIT_CODES } from '../../../src/shared/hook-constants.js';

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

let endlessModeFlag = 'true';
mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_ENDLESS_MODE_ENABLED: endlessModeFlag,
  }),
}));

mock.module('../../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => 'Final assistant message.',
}));

const FALLBACK = { continue: true, reason: 'worker_unreachable' };
type RenderBehavior = 'queued' | 'fallback' | 'throw';
let renderBehavior: RenderBehavior = 'queued';
const workerCalls: Array<{
  path: string;
  method: string;
  body?: unknown;
  options?: { timeoutMs?: number };
}> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  executeWithWorkerFallback: async (
    apiPath: string,
    method: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ) => {
    workerCalls.push({ path: apiPath, method, body, options });
    if (apiPath === '/api/sessions/render-bottle') {
      if (renderBehavior === 'throw') throw new Error('The operation timed out');
      if (renderBehavior === 'fallback') return FALLBACK;
    }
    return { status: 'queued' };
  },
  isWorkerFallback: (result: unknown) => result === FALLBACK,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCalls.length = 0;
  renderBehavior = 'queued';
  endlessModeFlag = 'true';
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/transcript-parser.js', () => realTranscriptParserSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

const baseInput = {
  sessionId: 'sess-render-stop',
  cwd: '/tmp/repo',
  platform: 'claude-code' as const,
  transcriptPath: '/tmp/fake.jsonl',
};

const SUCCESS_RESULT = {
  continue: true,
  suppressOutput: true,
  exitCode: HOOK_EXIT_CODES.SUCCESS,
};

async function runHandler(overrides: Record<string, unknown> = {}) {
  const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
  return summarizeHandler.execute({ ...baseInput, ...overrides } as any);
}

function renderCalls() {
  return workerCalls.filter(c => c.path === '/api/sessions/render-bottle');
}

function summarizeCalls() {
  return workerCalls.filter(c => c.path === '/api/sessions/summarize');
}

describe('summarizeHandler — Endless Mode render-on-Stop', () => {
  it('issues the summarize POST then the render POST, in that order', async () => {
    const result = await runHandler();

    expect(result).toEqual(SUCCESS_RESULT);
    expect(workerCalls.map(c => c.path)).toEqual([
      '/api/sessions/summarize',
      '/api/sessions/render-bottle',
    ]);

    const render = renderCalls()[0]!;
    expect(render.method).toBe('POST');
    expect(render.body).toEqual({
      contentSessionId: 'sess-render-stop',
      transcript_path: '/tmp/fake.jsonl',
      cwd: '/tmp/repo',
    });
    // Queue-and-return: the Stop hook must never ask the worker to block.
    expect('wait' in (render.body as Record<string, unknown>)).toBe(false);
    expect(render.options).toEqual({ timeoutMs: 5000 });
  });

  it('render returning a worker fallback leaves the handler result unchanged', async () => {
    renderBehavior = 'fallback';
    const result = await runHandler();

    expect(result).toEqual(SUCCESS_RESULT);
    expect(summarizeCalls()).toHaveLength(1);
    expect(renderCalls()).toHaveLength(1);
  });

  it('render throwing (fetch timeout) never escapes; result unchanged', async () => {
    renderBehavior = 'throw';
    const result = await runHandler();

    expect(result).toEqual(SUCCESS_RESULT);
    expect(summarizeCalls()).toHaveLength(1);
    expect(renderCalls()).toHaveLength(1);
  });

  it('skips the render POST when the flag is false; summarize unchanged', async () => {
    endlessModeFlag = 'false';
    const result = await runHandler();

    expect(result).toEqual(SUCCESS_RESULT);
    expect(summarizeCalls()).toHaveLength(1);
    expect(renderCalls()).toHaveLength(0);
  });

  it('skips the render POST on non-claude-code platforms', async () => {
    const result = await runHandler({
      platform: 'codex',
      lastAssistantMessage: 'Codex answer',
      transcriptPath: undefined,
    });

    expect(result).toEqual(SUCCESS_RESULT);
    expect(summarizeCalls()).toHaveLength(1);
    expect(renderCalls()).toHaveLength(0);
  });
});
