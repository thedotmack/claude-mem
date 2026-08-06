import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';

// bun's mock.module is process-global and sticky: it is never auto-unregistered
// and leaks into every file that runs afterwards. Snapshot each real module
// before mocking and re-register the snapshot in afterAll so the stubs below
// cannot break later suites that drive the real implementations.
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };
const actualProcessRegistry = { ...(await import('../../src/supervisor/process-registry.js')) };
const actualModeManager = { ...(await import('../../src/services/domain/ModeManager.js')) };

let scriptedMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...actualAgentSdk,
  query: () => (async function* () {
    for (const message of scriptedMessages) {
      yield message;
    }
  })(),
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
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    }),
  },
}));

afterAll(() => {
  mock.module('../../src/services/domain/ModeManager.js', () => actualModeManager);
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualAgentSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnvManager);
  mock.module('../../src/supervisor/process-registry.js', () => actualProcessRegistry);
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

const MEMORY_SESSION_ID = 'memory-session-3492';
const QUEUED_TIMESTAMP = 1700000000000;

const OBSERVATION_XML = `
<observation>
  <type>discovery</type>
  <title>Observed the queued tool call</title>
  <narrative>The queued batch reached the parser.</narrative>
  <facts><fact>Batch survived the textless frame</fact></facts>
  <concepts><concept>observer</concept></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

function assistantFrame(content: unknown) {
  return {
    type: 'assistant',
    session_id: MEMORY_SESSION_ID,
    message: {
      content,
      usage: { input_tokens: 120, output_tokens: 4 },
    },
  };
}

function resultFrame() {
  return {
    type: 'result',
    session_id: MEMORY_SESSION_ID,
    usage: { input_tokens: 120, output_tokens: 40 },
    total_cost_usd: 0.001,
  };
}

function createSession(): ActiveSession {
  return {
    sessionDbId: 3492,
    contentSessionId: 'content-3492',
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
    earliestPendingTimestamp: QUEUED_TIMESTAMP,
    claimedMessageIds: [1],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

function createHarness(session: ActiveSession) {
  // Mirrors SessionManager.confirmClaimedMessages: the claimed batch and the
  // batch's original timestamp are both released on confirm, so a later
  // dispatch in the same turn sees an empty batch.
  let claimedMessages: Array<{ type: string; tool_name?: string; tool_input?: unknown }> = [
    { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/queued.ts' } },
  ];

  const confirmClaimedMessages = mock(async () => {
    const confirmed = claimedMessages.length;
    claimedMessages = [];
    session.claimedMessageIds = [];
    session.earliestPendingTimestamp = null;
    return confirmed;
  });
  const resetProcessingToPending = mock(async () => 0);
  const storeObservations = mock(() => ({
    observationIds: [7],
    summaryId: null,
    createdAtEpoch: QUEUED_TIMESTAMP,
  }));

  const sessionManager = {
    confirmClaimedMessages,
    resetProcessingToPending,
    getClaimedMessages: () => claimedMessages,
    getMessageIterator: async function* () {},
  };

  const dbManager = {
    getSessionStore: () => ({
      updateMemorySessionId: () => {},
      ensureMemorySessionIdRegistered: () => {},
      getSessionById: () => ({ memory_session_id: MEMORY_SESSION_ID }),
      storeObservations,
    }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  };

  return {
    confirmClaimedMessages,
    resetProcessingToPending,
    storeObservations,
    remainingClaimed: () => claimedMessages,
    provider: new ClaudeProvider(dbManager as never, sessionManager as never),
  };
}

describe('ClaudeProvider assistant frame dispatch (#3492)', () => {
  beforeEach(() => {
    scriptedMessages = [];
  });

  it('leaves the claimed batch intact when a frame carries no text block', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
      assistantFrame([{ type: 'text', text: OBSERVATION_XML }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    const [memorySessionId, project, observations, , , , originalTimestamp] =
      harness.storeObservations.mock.calls[0] as unknown[] as [
        string, string, Array<{ files_read: string[] }>, unknown, number, number, number | undefined,
      ];

    expect(memorySessionId).toBe(MEMORY_SESSION_ID);
    expect(project).toBe('observer-project');
    // The tool_use frame must not have confirmed the batch away: the XML frame
    // still sees the queued Read as file evidence, and still carries the
    // batch's original timestamp.
    expect(observations[0].files_read).toEqual(['src/queued.ts']);
    expect(originalTimestamp).toBe(QUEUED_TIMESTAMP);
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(1);
  });

  it('leaves the claimed batch intact when a frame carries only thinking blocks', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame([{ type: 'thinking', thinking: 'considering the batch', signature: 'sig' }]),
      assistantFrame([{ type: 'text', text: OBSERVATION_XML }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    const [, , observations] = harness.storeObservations.mock.calls[0] as unknown[] as [
      string, string, Array<{ files_read: string[] }>,
    ];
    expect(observations[0].files_read).toEqual(['src/queued.ts']);
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(1);
  });

  it('still confirms and drops the batch when the frame carries an empty text block', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame([{ type: 'text', text: '   ' }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).not.toHaveBeenCalled();
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(1);
    expect(harness.remainingClaimed()).toEqual([]);
  });

  it('still confirms and drops the batch for idle prose', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame([
        { type: 'text', text: 'No observations to record yet - waiting for tool executions and results.' },
      ]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).not.toHaveBeenCalled();
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(1);
    expect(harness.remainingClaimed()).toEqual([]);
  });

  it('dispatches string content as text', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [assistantFrame(OBSERVATION_XML), resultFrame()];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(1);
  });

  it('keeps the batch claimed when the whole turn produced no text frame', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    // Nothing was answered, so nothing is confirmed. The next generator pass
    // re-yields the batch (SessionManager.getMessageIterator resets claimed
    // messages back to pending before draining).
    expect(harness.confirmClaimedMessages).not.toHaveBeenCalled();
    expect(harness.remainingClaimed()).toHaveLength(1);
    expect(session.earliestPendingTimestamp).toBe(QUEUED_TIMESTAMP);
  });
});
