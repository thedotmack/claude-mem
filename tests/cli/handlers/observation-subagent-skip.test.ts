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

// Mutable settings the handler sees via loadFromFileOnce() (used by both
// shouldTrackProject and shouldSkipAgentObservation). Tests reset it per case.
let mockSettings: Record<string, string> = {
  CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
  CLAUDE_MEM_SKIP_AGENT_TYPES: '',
};

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => mockSettings,
}));

// PostToolUse spools and exits: any awaited worker call is a regression.
const awaitedWorkerCallLog: Array<{ path: string; method: string; body: unknown }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: (path: string, method: string, body: unknown) => {
    awaitedWorkerCallLog.push({ path, method, body });
    return Promise.resolve({ status: 'queued' });
  },
  ensureWorkerRunning: () => {
    awaitedWorkerCallLog.push({ path: 'ensureWorkerRunning', method: '', body: null });
    return Promise.resolve(true);
  },
  workerHttpRequest: () => Promise.resolve(new Response('{"status":"draining"}', { status: 202 })),
}));

// Mutable runtime context so individual cases can flip between the `worker` and
// `server` runtimes. The skip check must run BEFORE this branch, so a
// skipped subagent observation must reach neither dispatchToWorker nor recordEvent.
const recordEventLog: Array<unknown> = [];
let mockRuntime: Record<string, unknown> = { runtime: 'worker' };
const serverRuntime = () => ({
  runtime: 'server',
  projectId: 'proj-test',
  serverBaseUrl: 'http://127.0.0.1:0',
  client: {
    recordEvent: (evt: unknown) => {
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
import { codexAdapter } from '../../../src/cli/adapters/codex.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

/** Observations handed to the worker (via the hook spool). */
function spooled() {
  expect(awaitedWorkerCallLog).toHaveLength(0);
  return spooledEntries('observation');
}

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  awaitedWorkerCallLog.length = 0;
  recordEventLog.length = 0;
  mockRuntime = { runtime: 'worker' };
  mockSettings = {
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
    CLAUDE_MEM_SKIP_AGENT_TYPES: '',
  };
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

const baseInput = (over: Record<string, unknown> = {}) => ({
  sessionId: 'session-abc',
  cwd: '/tmp',
  platform: 'claude-code',
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  toolResponse: { stdout: '' },
  ...over,
});

describe('observationHandler — subagent observation filtering (#2736)', () => {
  const codexInput = () => ({
    ...codexAdapter.normalizeInput({
      session_id: 'codex-session',
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      tool_response: { stdout: '/tmp' },
      tool_use_id: 'call-codex-1',
      agent_id: 'codex-agent-1',
      agent_type: 'explorer',
    }),
    platform: 'codex',
  });

  it('spools native Codex tool IDs and agent attribution for worker ingestion', async () => {
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    await observationHandler.execute(codexInput());

    expect(spooled()).toHaveLength(1);
    expect(spooled()[0].payload).toMatchObject({
      contentSessionId: 'codex-session',
      platformSource: 'codex',
      toolUseId: 'call-codex-1',
      agentId: 'codex-agent-1',
      agentType: 'explorer',
    });
  });

  it('honors subagent filtering for native Codex hook payloads', async () => {
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    await observationHandler.execute(codexInput());

    expect(spooled()).toHaveLength(0);
    expect(recordEventLog).toHaveLength(0);
  });

  it('spools a main-session observation for the worker (defaults)', async () => {
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput());
    expect(result.continue).toBe(true);
    expect(spooled().length).toBe(1);
    expect(spooled()[0].kind).toBe('observation');
  });

  it('dispatches subagent observations by default (no silent behavior change)', async () => {
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(
      baseInput({ agentId: 'agent-1', agentType: 'workflow-subagent' })
    );
    expect(result.continue).toBe(true);
    expect(spooled().length).toBe(1);
  });

  it('skips ALL subagent observations when CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS=true', async () => {
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(
      baseInput({ agentId: 'agent-1', agentType: 'workflow-subagent' })
    );
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(spooled().length).toBe(0); // no HTTP round-trip, no provider call
  });

  it('does NOT skip the main session when the global toggle is on', async () => {
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput()); // no agentId
    expect(result.continue).toBe(true);
    expect(spooled().length).toBe(1);
  });

  it('does NOT skip an agent-id-only event (transcript-watch / Grok Bot seat) when the global toggle is on', async () => {
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    mockSettings.CLAUDE_MEM_SKIP_AGENT_TYPES = 'workflow-subagent';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput({ agentId: 'grok-seat-7' }));
    expect(result.continue).toBe(true);
    expect(spooled().length).toBe(1);
  });

  it('skips only the listed agent_type values', async () => {
    mockSettings.CLAUDE_MEM_SKIP_AGENT_TYPES = 'workflow-subagent,Explore';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');

    const skipped = await observationHandler.execute(
      baseInput({ agentId: 'a', agentType: 'workflow-subagent' })
    );
    expect(skipped.continue).toBe(true);
    expect(spooled().length).toBe(0);

    const kept = await observationHandler.execute(
      baseInput({ agentId: 'b', agentType: 'Plan' })
    );
    expect(kept.continue).toBe(true);
    expect(spooled().length).toBe(1);
  });

  // The skip check sits AHEAD of the runtime branch, so it must protect the
  // server runtime too — not just the worker dispatch. These cases would
  // fail if the check were ever moved down into the worker-only branch.
  it('skips before the server runtime branch — recordEvent is never called', async () => {
    mockRuntime = serverRuntime();
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(
      baseInput({ agentId: 'agent-1', agentType: 'workflow-subagent' })
    );
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(recordEventLog.length).toBe(0); // never reached the provider via the server runtime
    expect(spooled().length).toBe(0);
  });

  it('still records main-session observations on the server runtime', async () => {
    mockRuntime = serverRuntime();
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput()); // no agentId
    expect(result.continue).toBe(true);
    expect(recordEventLog.length).toBe(1);
    expect(spooled().length).toBe(0);
  });
});
