import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';

// #3664: a gateway that synthesizes streaming for the Claude path reports
// input_tokens: 0 on every assistant frame, so discovery_tokens collapsed to
// output only and the session counters missed the input. The turn's result
// message carries the real usage; it corrects both at the turn boundary.

// bun's mock.module is process-global and sticky; snapshot and restore.
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };
const actualProcessRegistry = { ...(await import('../../src/supervisor/process-registry.js')) };
const actualModeManager = { ...(await import('../../src/services/domain/ModeManager.js')) };

let scriptedMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...actualAgentSdk,
  query: () => (async function* () {
    for (const message of scriptedMessages) yield message;
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
        observation_types: [{ id: 'discovery' }],
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

const MEMORY_SESSION_ID = 'memory-session-3664';

const OBSERVATION_XML = `
<observation>
  <type>discovery</type>
  <title>Read the gateway response</title>
  <narrative>The turn produced one observation.</narrative>
  <facts><fact>One observation stored</fact></facts>
  <concepts><concept>observer</concept></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

function assistantFrame(usage: Record<string, number>) {
  return {
    type: 'assistant',
    session_id: MEMORY_SESSION_ID,
    message: { content: [{ type: 'text', text: OBSERVATION_XML }], usage },
  };
}

function resultFrame(usage: Record<string, number>) {
  return {
    type: 'result',
    session_id: MEMORY_SESSION_ID,
    subtype: 'success',
    is_error: false,
    usage,
    total_cost_usd: 0.001,
  };
}

function createSession(): ActiveSession {
  return {
    sessionDbId: 3664,
    contentSessionId: 'content-3664',
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
  let claimedMessages: Array<{ type: string; tool_name?: string; tool_input?: unknown }> = [
    { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/gateway.ts' } },
  ];
  const storeObservations = mock((..._args: unknown[]) => ({
    observationIds: [41],
    mergedIntoExisting: [false],
    insertedObservationIds: [41],
    summaryId: null,
    createdAtEpoch: 1700000000000,
  }));
  const updateDiscoveryTokens = mock((_ids: number[], _summaryId: number | null, _tokens: number) => {});

  const sessionManager = {
    confirmClaimedMessages: mock(async () => {
      const confirmed = claimedMessages.length;
      claimedMessages = [];
      session.claimedMessageIds = [];
      session.earliestPendingTimestamp = null;
      return confirmed;
    }),
    resetProcessingToPending: mock(async () => 0),
    getClaimedMessages: () => claimedMessages,
    getMessageIterator: async function* () {},
  };
  const dbManager = {
    getSessionStore: () => ({
      updateMemorySessionId: () => {},
      ensureMemorySessionIdRegistered: () => {},
      getSessionById: () => ({ memory_session_id: MEMORY_SESSION_ID }),
      storeObservations,
      updateDiscoveryTokens,
    }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  };
  return {
    storeObservations,
    updateDiscoveryTokens,
    provider: new ClaudeProvider(dbManager as never, sessionManager as never),
  };
}

describe('ClaudeProvider discovery-token correction from the result usage (#3664)', () => {
  beforeEach(() => {
    scriptedMessages = [];
  });

  it('gives the rows of a zero-input turn the turn\'s real cost and counts the missed input', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame({ input_tokens: 0, output_tokens: 1 }),
      resultFrame({ input_tokens: 900, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 40 }),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    // The frame-based value is output only: the input never arrived.
    expect((harness.storeObservations.mock.calls[0] as unknown[])[5]).toBe(1);
    expect(harness.updateDiscoveryTokens).toHaveBeenCalledTimes(1);
    expect(harness.updateDiscoveryTokens).toHaveBeenCalledWith([41], null, 900 + 100 + 40);
    expect(session.cumulativeInputTokens).toBe(1000);
    expect(session.cumulativeCacheReadTokens).toBe(50);
  });

  it('leaves a turn whose frames reported input alone', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame({ input_tokens: 900, output_tokens: 1 }),
      resultFrame({ input_tokens: 900, output_tokens: 40 }),
    ];

    await harness.provider.startSession(session);

    expect(harness.updateDiscoveryTokens).not.toHaveBeenCalled();
    expect(session.cumulativeInputTokens).toBe(900);
  });

  it('keeps the next turn\'s discovery delta its own after a correction', async () => {
    const session = createSession();
    const harness = createHarness(session);

    scriptedMessages = [
      assistantFrame({ input_tokens: 0, output_tokens: 1 }),
      resultFrame({ input_tokens: 900, output_tokens: 40 }),
      assistantFrame({ input_tokens: 0, output_tokens: 3 }),
      resultFrame({ input_tokens: 950, output_tokens: 30 }),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(2);
    // The second turn's frame-based delta is its own placeholder output, not
    // the first turn's corrected input.
    expect((harness.storeObservations.mock.calls[1] as unknown[])[5]).toBe(3);
    expect(harness.updateDiscoveryTokens).toHaveBeenCalledTimes(2);
    expect(harness.updateDiscoveryTokens.mock.calls[1]).toEqual([[41], null, 950 + 30]);
  });
});
