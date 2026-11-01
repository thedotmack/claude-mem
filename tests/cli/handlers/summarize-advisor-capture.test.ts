import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

// The Stop hook records the turn's advisor calls only when
// CLAUDE_MEM_CAPTURE_ADVISOR_CALLS is on, and only in worker runtime: in server
// runtime it must not reach for a local worker (plan-24 step 4).

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realObservedBilling from '../../../src/shared/observed-billing.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realObservedBillingSnapshot = { ...realObservedBilling };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

let captureSetting = 'false';
let runtimeMode: 'worker' | 'server' = 'worker';

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => (key === 'CLAUDE_MEM_DATA_DIR' ? join(homedir(), '.claude-mem') : ''),
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_CAPTURE_ADVISOR_CALLS: captureSetting,
  }),
}));

mock.module('../../../src/shared/observed-billing.js', () => ({
  claudeJsonPath: () => '/tmp/fake/.claude.json',
  detectObservedBilling: () => undefined,
}));

// Awaited worker calls must stay empty: Stop spools and exits.
const workerCalls: Array<{ path: string; body: any }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  ensureWorkerRunning: () => {
    workerCalls.push({ path: 'ensureWorkerRunning', body: null });
    return Promise.resolve(true);
  },
  workerHttpRequest: () => Promise.resolve(new Response('{"status":"draining"}', { status: 202 })),
  executeWithWorkerFallback: async (apiPath: string, _method: string, body: unknown) => {
    workerCalls.push({ path: apiPath, body });
    return { status: 'queued' };
  },
}));

const serverEvents: unknown[] = [];
mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => runtimeMode === 'server'
    ? {
        runtime: 'server',
        projectId: 'server-project',
        serverBaseUrl: 'http://server.test',
        client: {
          startSession: async () => ({ session: { id: 'server-session' } }),
          recordEvent: async (event: unknown) => { serverEvents.push(event); return {}; },
          endSession: async () => ({}),
        },
      }
    : { runtime: 'worker' },
}));

import { logger } from '../../../src/utils/logger.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let transcriptDir: string;
let transcriptPath: string;
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  workerCalls.length = 0;
  serverEvents.length = 0;
  captureSetting = 'false';
  runtimeMode = 'worker';
  loggerSpies = (['info', 'debug', 'warn', 'error', 'failure', 'dataIn'] as const)
    .map(level => spyOn(logger, level).mockImplementation(() => {}));

  transcriptDir = mkdtempSync(join(tmpdir(), 'cm-advisor-stop-'));
  transcriptPath = join(transcriptDir, 'transcript.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'why is the sync stalling?' }] },
      timestamp: '2026-07-06T05:00:00.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      advisorModel: 'claude-fable-5',
      message: { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srvtoolu_stop_1', name: 'advisor', input: {} }] },
      timestamp: '2026-07-06T05:00:01.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      advisorModel: 'claude-fable-5',
      message: {
        role: 'assistant',
        content: [{ type: 'advisor_tool_result', tool_use_id: 'srvtoolu_stop_1', content: { type: 'advisor_result', text: 'Check the lease timeout.' } }],
      },
      timestamp: '2026-07-06T05:00:02.000Z',
    }),
  ].join('\n') + '\n');
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  rmSync(transcriptDir, { recursive: true, force: true });
  tempSpool.restore();
});

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/observed-billing.js', () => realObservedBillingSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

function stopInput() {
  return {
    sessionId: 'advisor-stop-session',
    cwd: transcriptDir,
    platform: 'claude-code',
    transcriptPath,
    lastAssistantMessage: 'Done.',
  } as any;
}

describe('Stop hook advisor-call capture', () => {
  it('records nothing by default (opt-in)', async () => {
    await summarizeHandler.execute(stopInput());

    expect(workerCalls).toHaveLength(0);
    expect(spooledEntries().map(entry => entry.kind)).toEqual(['summarize']);
  });

  it('records the turn\'s advisor calls before queueing the summary when enabled', async () => {
    captureSetting = 'true';

    await summarizeHandler.execute(stopInput());

    expect(workerCalls).toHaveLength(0);
    const entries = spooledEntries();
    expect(entries.map(entry => entry.kind)).toEqual(['advisor_calls', 'summarize']);
    const body = entries[0].payload as any;
    expect(body.contentSessionId).toBe('advisor-stop-session');
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toMatchObject({
      toolUseId: 'srvtoolu_stop_1',
      advice: 'Check the lease timeout.',
      advisorModel: 'claude-fable-5',
      lastUserMessage: 'why is the sync stalling?',
    });
    expect(typeof body.calls[0].transcriptByteOffset).toBe('number');
  });

  it('never reaches for a local worker in server runtime', async () => {
    captureSetting = 'true';
    runtimeMode = 'server';

    await summarizeHandler.execute(stopInput());

    expect(workerCalls).toHaveLength(0);
    expect(spooledEntries()).toHaveLength(0);
    expect(serverEvents).toHaveLength(1);
  });
});
