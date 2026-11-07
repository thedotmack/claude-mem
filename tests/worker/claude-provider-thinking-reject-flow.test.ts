import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';

// Provider-level coverage for #4732: drives ClaudeProvider.startSession over a
// scripted SDK stream and asserts what the session and the next generation's
// SDK options look like after a gateway rejects the thinking param.
//
// bun's mock.module is process-global and sticky, so every real module is
// snapshotted first and re-registered in afterAll.
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };
const actualProcessRegistry = { ...(await import('../../src/supervisor/process-registry.js')) };
const actualModeManager = { ...(await import('../../src/services/domain/ModeManager.js')) };

type ScriptStep = Record<string, unknown> | { throwError: unknown };

let scriptedSteps: ScriptStep[] = [];
const capturedSdkOptions: Array<Record<string, unknown>> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...actualAgentSdk,
  query: (args: { options: Record<string, unknown> }) => {
    capturedSdkOptions.push(args.options);
    const steps = scriptedSteps;
    return (async function* () {
      for (const step of steps) {
        if ('throwError' in step) throw step.throwError;
        yield step;
      }
    })();
  },
}));

mock.module('../../src/shared/find-claude-executable.js', () => ({
  ...actualFindClaude,
  findClaudeExecutable: () => '/mock/claude',
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnvManager,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH ?? '' }),
  getAuthMethodDescription: () => 'test-auth',
}));

mock.module('../../src/supervisor/process-registry.js', () => ({
  ...actualProcessRegistry,
  waitForSlot: async () => ({ release: () => {} }),
  createSdkSpawnFactory: () => () => {
    throw new Error('spawn factory must not run in this test');
  },
  getSdkProcessForSession: () => undefined,
  ensureSdkProcessExit: async () => {},
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ...actualModeManager,
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
    }),
  },
}));

const previousThinkingSetting = process.env.CLAUDE_MEM_OBSERVER_THINKING;
// Pin the operator setting so a developer's own settings.json can't change the
// shipped default this suite asserts.
process.env.CLAUDE_MEM_OBSERVER_THINKING = 'disabled';

afterAll(() => {
  if (previousThinkingSetting === undefined) delete process.env.CLAUDE_MEM_OBSERVER_THINKING;
  else process.env.CLAUDE_MEM_OBSERVER_THINKING = previousThinkingSetting;
  mock.module('../../src/services/domain/ModeManager.js', () => actualModeManager);
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualAgentSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnvManager);
  mock.module('../../src/supervisor/process-registry.js', () => actualProcessRegistry);
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

const MEMORY_SESSION_ID = 'memory-session-4732';
const GLM_REJECTION =
  'API Error: 400 {[1210][该模型始终思考，不支持关闭思考；请使用 low、high 或 max。]} (model_id: thudm-glm-5.3-flash)';

function thinkingRejectedResultFrame() {
  return {
    type: 'result',
    session_id: MEMORY_SESSION_ID,
    subtype: 'success',
    is_error: true,
    result: GLM_REJECTION,
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
  };
}

function textlessFailureResultFrame() {
  return {
    type: 'result',
    session_id: MEMORY_SESSION_ID,
    subtype: 'error_during_execution',
    is_error: true,
    usage: { input_tokens: 0, output_tokens: 0 },
    total_cost_usd: 0,
  };
}

function createSession(): ActiveSession {
  return {
    sessionDbId: 4732,
    contentSessionId: 'content-4732',
    memorySessionId: null,
    project: 'observer-project',
    platformSource: 'claude',
    userPrompt: 'run the project',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 2,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: 1700000000000,
    claimedMessageIds: [1],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

function createHarness(session: ActiveSession) {
  const confirmClaimedMessages = mock(async () => {
    session.claimedMessageIds = [];
    return 1;
  });
  const resetProcessingToPending = mock(async () => 1);
  const sessionManager = {
    confirmClaimedMessages,
    resetProcessingToPending,
    getClaimedMessages: () => [{ type: 'observation', tool_name: 'Read', tool_input: { file_path: 'a.ts' } }],
    getMessageIterator: async function* () {},
  };
  const dbManager = {
    getSessionStore: () => ({
      updateMemorySessionId: () => {},
      ensureMemorySessionIdRegistered: () => {},
      getSessionById: () => ({ memory_session_id: MEMORY_SESSION_ID }),
      storeObservations: () => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }),
    }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  };
  return {
    confirmClaimedMessages,
    resetProcessingToPending,
    provider: new ClaudeProvider(dbManager as never, sessionManager as never),
  };
}

/** Start the next generation on the same session, the way the transport resume does. */
async function runNextGeneration(provider: InstanceType<typeof ClaudeProvider>, session: ActiveSession) {
  session.abortController = new AbortController();
  session.abortReason = undefined;
  scriptedSteps = [];
  await provider.startSession(session);
  return capturedSdkOptions[capturedSdkOptions.length - 1];
}

describe('ClaudeProvider thinking-param rejection (#4732)', () => {
  beforeEach(() => {
    scriptedSteps = [];
    capturedSdkOptions.length = 0;
  });

  it('strips the param and releases the batch when a result frame carries the rejection', async () => {
    const session = createSession();
    const harness = createHarness(session);
    scriptedSteps = [thinkingRejectedResultFrame()];

    await harness.provider.startSession(session);

    expect(capturedSdkOptions[0].thinking).toEqual({ type: 'disabled' });
    expect(session.observerThinkingStripped).toBe(true);
    expect(session.abortReason).toBe('transport:thinking_rejected');
    expect(harness.resetProcessingToPending).toHaveBeenCalledTimes(1);
    expect(harness.confirmClaimedMessages).not.toHaveBeenCalled();

    const nextOptions = await runNextGeneration(harness.provider, session);
    expect('thinking' in nextOptions).toBe(false);
  });

  it('strips the param when the rejection is thrown with a structured HTTP status', async () => {
    const session = createSession();
    const harness = createHarness(session);
    // The message alone names thinking but not the 400; only the structured
    // status says the request itself was refused.
    scriptedSteps = [{ throwError: Object.assign(new Error('thinking parameter is not supported'), { status: 400 }) }];

    await expect(harness.provider.startSession(session)).rejects.toThrow('thinking parameter is not supported');

    expect(session.observerThinkingStripped).toBe(true);
    expect(session.abortReason).toBe('transport:thinking_rejected');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(harness.resetProcessingToPending).toHaveBeenCalledTimes(1);

    const nextOptions = await runNextGeneration(harness.provider, session);
    expect('thinking' in nextOptions).toBe(false);
  });

  it('does not loop on a second rejection once the param is already stripped', async () => {
    const session = createSession();
    session.observerThinkingStripped = true;
    const harness = createHarness(session);
    scriptedSteps = [thinkingRejectedResultFrame()];

    await harness.provider.startSession(session);

    expect('thinking' in capturedSdkOptions[0]).toBe(false);
    // The ordinary failed-turn retry, then the stream's own end: not another
    // thinking pause, which would re-send the same request forever.
    expect(session.observerThinkingStripped).toBe(true);
    expect(session.abortReason).toBe('transport:sdk_eof');
  });

  it('still strips when an earlier textless failure already used the ordinary retry', async () => {
    const session = createSession();
    const harness = createHarness(session);
    scriptedSteps = [textlessFailureResultFrame(), thinkingRejectedResultFrame()];

    await harness.provider.startSession(session);

    expect(session.observerThinkingStripped).toBe(true);
    expect(session.abortReason).toBe('transport:thinking_rejected');
    // One reset for the ordinary retry, one for the thinking pause; the
    // rejected turn's empty reply never reached the skip contract.
    expect(harness.resetProcessingToPending).toHaveBeenCalledTimes(2);
    expect(harness.confirmClaimedMessages).not.toHaveBeenCalled();
  });
});
