import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realTranscriptParser from '../../../src/shared/transcript-parser.js';
import * as realObservedBilling from '../../../src/shared/observed-billing.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realTranscriptParserSnapshot = { ...realTranscriptParser };
const realObservedBillingSnapshot = { ...realObservedBilling };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

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

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

// Counts every transcript read that can yield an observed model: the combined
// extractLastAssistantTurn (transcript branch) and the model-only
// extractLastAssistantModel (inline lastAssistantMessage branch). The Stop
// hook must read the transcript exactly once per invocation.
let modelExtractCallCount = 0;
mock.module('../../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => 'A normal assistant turn.',
  extractLastAssistantTurn: () => {
    modelExtractCallCount += 1;
    return { text: 'A normal assistant turn.', model: 'claude-test-model' };
  },
  extractLastAssistantModel: () => {
    modelExtractCallCount += 1;
    return 'claude-test-model';
  },
}));

let billingDetectCallCount = 0;
mock.module('../../../src/shared/observed-billing.js', () => ({
  claudeJsonPath: () => '/tmp/fake/.claude.json',
  detectObservedBilling: () => {
    billingDetectCallCount += 1;
    return 'max';
  },
}));

const workerCallLog: Array<{ path: string; method: string; body: any }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    workerCallLog.push({ path: apiPath, method: options?.method ?? 'GET', body: options?.body });
    return Promise.resolve(new Response('{"status":"queued"}', { status: 200 }));
  },
  executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    return { status: 'queued' };
  },
  isWorkerFallback: (_result: unknown) => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  modelExtractCallCount = 0;
  billingDetectCallCount = 0;
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
  mock.module('../../../src/shared/observed-billing.js', () => realObservedBillingSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

function postedBody(): any {
  expect(workerCallLog).toHaveLength(1);
  expect(workerCallLog[0].path).toBe('/api/sessions/summarize');
  const { body } = workerCallLog[0];
  return typeof body === 'string' ? JSON.parse(body) : body;
}

describe('summarizeHandler — observed model + billing in the summarize body', () => {
  it('sends observedModel and observedBilling for a claude-code Stop hook', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-observed',
      cwd: '/tmp',
      platform: 'claude-code',
      transcriptPath: '/tmp/fake.jsonl',
    });

    expect(result.continue).toBe(true);
    const body = postedBody();
    expect(body.observedModel).toBe('claude-test-model');
    expect(typeof body.observedBilling).toBe('string');
    expect(body.observedBilling).toBe('max');
    expect(modelExtractCallCount).toBe(1);
    expect(billingDetectCallCount).toBe(1);
  });

  it('skips billing detection on non-claude-code platforms but still sends observedModel', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute({
      sessionId: 'sess-cursor',
      cwd: '/tmp',
      platform: 'cursor',
      transcriptPath: '/tmp/cursor.jsonl',
    });

    const body = postedBody();
    expect(body.observedModel).toBe('claude-test-model');
    expect(body.observedBilling).toBeUndefined();
    expect(billingDetectCallCount).toBe(0);
    expect(modelExtractCallCount).toBe(1);
  });

  it('reads only the model (one transcript read) when an inline lastAssistantMessage comes with a transcriptPath', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute({
      sessionId: 'sess-inline-with-transcript',
      cwd: '/tmp',
      platform: 'codex',
      transcriptPath: '/tmp/codex.jsonl',
      lastAssistantMessage: 'Codex answer',
    });

    const body = postedBody();
    expect(body.last_assistant_message).toBe('Codex answer');
    expect(body.observedModel).toBe('claude-test-model');
    expect(modelExtractCallCount).toBe(1);
  });

  it('omits observedModel when there is no transcript (Codex inline message path)', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute({
      sessionId: 'sess-codex',
      cwd: '/tmp',
      platform: 'codex',
      lastAssistantMessage: 'Codex answer',
    });

    const body = postedBody();
    expect(body.observedModel).toBeUndefined();
    expect(body.observedBilling).toBeUndefined();
    expect(modelExtractCallCount).toBe(0);
    expect(billingDetectCallCount).toBe(0);
  });
});
