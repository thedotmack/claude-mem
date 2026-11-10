import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { installScriptedClaudeSdk, createScriptedSession } from '../fixtures/worker/scripted-claude-sdk.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { sessionDbWithoutMedia } from '../fixtures/worker/session-db-without-media.js';

// #3664: a gateway that synthesizes streaming for the Claude path reports
// input_tokens: 0 on every assistant frame, so discovery_tokens collapsed to
// output only and the session counters missed the input. The turn's result
// message carries the real usage; it corrects both at the turn boundary.

const sdkFixture = installScriptedClaudeSdk();
afterAll(() => sdkFixture.restore());

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
  return createScriptedSession(3664, { earliestPendingTimestamp: 1700000000000, claimedMessageIds: [1] });
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
      db: sessionDbWithoutMedia(), ensureMemorySessionIdRegistered: () => {},
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
    sdkFixture.messages = [];
  });

  it('gives the rows of a zero-input turn the turn\'s real cost and counts the missed input', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
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

  // A repeated Stop updates the turn's summary in place (#5225). The result's
  // usage must still reach that row; updateDiscoveryTokens keeps the larger count.
  it('corrects a summary a repeated stop reused when the gateway reports input only in the result (#5225)', async () => {
    const session = createSession();
    const harness = createHarness(session);
    harness.storeObservations.mockImplementation((() => ({
      observationIds: [41],
      mergedIntoExisting: [false],
      insertedObservationIds: [41],
      summaryId: 7,
      summaryUpdated: true,
      createdAtEpoch: 1700000000000,
    })) as never);

    sdkFixture.messages = [
      assistantFrame({ input_tokens: 0, output_tokens: 1 }),
      resultFrame({ input_tokens: 900, output_tokens: 40 }),
    ];

    await harness.provider.startSession(session);

    expect(harness.updateDiscoveryTokens).toHaveBeenCalledWith([41], 7, 900 + 40);
  });

  // A turn the gateway streams back as several assistant frames, each with
  // zero input: every row the turn stored gets the turn's cost, and the
  // missed input is counted once, not once per frame.
  it('corrects every row of a multi-frame zero-input turn and counts its input once', async () => {
    const session = createSession();
    const harness = createHarness(session);
    let nextId = 41;
    harness.storeObservations.mockImplementation(() => {
      const id = nextId++;
      return { observationIds: [id], mergedIntoExisting: [false], insertedObservationIds: [id], summaryId: null, createdAtEpoch: 1700000000000 };
    });

    sdkFixture.messages = [
      assistantFrame({ input_tokens: 0, output_tokens: 1 }),
      assistantFrame({ input_tokens: 0, output_tokens: 2 }),
      resultFrame({ input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 40 }),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(2);
    expect(harness.updateDiscoveryTokens).toHaveBeenCalledTimes(1);
    expect(harness.updateDiscoveryTokens).toHaveBeenCalledWith([41, 42], null, 900 + 100 + 40);
    expect(session.cumulativeInputTokens).toBe(1000);
  });

  it('leaves a turn whose frames reported input alone', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
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

    sdkFixture.messages = [
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
