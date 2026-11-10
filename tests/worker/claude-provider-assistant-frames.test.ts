import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { installScriptedClaudeSdk, createScriptedSession } from '../fixtures/worker/scripted-claude-sdk.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { sessionDbWithoutMedia } from '../fixtures/worker/session-db-without-media.js';

const sdkFixture = installScriptedClaudeSdk();
afterAll(() => sdkFixture.restore());

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
const { logger } = await import('../../src/utils/logger.js');

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

function resultFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    session_id: MEMORY_SESSION_ID,
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 120, output_tokens: 40 },
    total_cost_usd: 0.001,
    ...overrides,
  };
}

function createSession(): ActiveSession {
  return createScriptedSession(3492, { earliestPendingTimestamp: 1700000000000, claimedMessageIds: [1] });
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
  // Mirrors SessionManager.resetProcessingToPending: the claim is released on
  // the session as well as in the buffer. Without this, the stream-end release
  // below sees a still-claimed batch and the fake counts a second reset that
  // the real manager never makes.
  const resetProcessingToPending = mock(async () => {
    session.claimedMessageIds = [];
    return 0;
  });
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
      db: sessionDbWithoutMedia(), ensureMemorySessionIdRegistered: () => {},
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
    sdkFixture.messages = [];
  });

  it('leaves the claimed batch intact when a frame carries no text block', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
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

    sdkFixture.messages = [
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

  // Every mode names the <skip_summary /> sentinel, so an empty or prose reply
  // to a queued batch did not answer it: the batch is asked for again once, in
  // a fresh generation, instead of being confirmed away.

  it.each([
    ['empty text', [{ type: 'text', text: '   ' }], 'output_retry:idle'],
    ['idle prose', [{ type: 'text', text: 'No observations to record yet - waiting for tool executions and results.' }], 'output_retry:prose'],
    ['textless turn', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }], 'output_retry:idle'],
  ])('hands the batch back once for %s', async (_label, content, abortReason) => {
    const session = createSession();
    const harness = createHarness(session);
    sdkFixture.messages = [assistantFrame(content), resultFrame()];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).not.toHaveBeenCalled();
    expect(harness.confirmClaimedMessages).not.toHaveBeenCalled();
    expect(harness.resetProcessingToPending).toHaveBeenCalledTimes(1);
    expect(session.abortReason).toBe(abortReason);
  });

  it('dispatches string content as text', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [assistantFrame(OBSERVATION_XML), resultFrame()];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(1);
  });

  // #3454: the idle hand-off names why the turn was empty — block kinds only,
  // never their content — so a thinking/tool_use-only turn is distinguishable
  // from a deliberate empty reply in the field.
  it('names the textless turn shape on the idle hand-off', async () => {
    const session = createSession();
    const harness = createHarness(session);
    const { logger } = await import('../../src/utils/logger.js');
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      sdkFixture.messages = [
        assistantFrame([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { secret: 'do-not-log' } }]),
        assistantFrame([{ type: 'thinking', thinking: 'private reasoning' }, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }]),
        resultFrame(),
      ];

      await harness.provider.startSession(session);

      const idleWarn = warn.mock.calls.find(([, message]) => String(message).includes('non-XML idle response'));
      expect(idleWarn?.[2]).toMatchObject({ outputClass: 'idle', emptyOutputReason: 'non-text-blocks-only(thinking,tool_use)' });
      expect(JSON.stringify(idleWarn)).not.toContain('do-not-log');
      expect(JSON.stringify(idleWarn)).not.toContain('private reasoning');
    } finally {
      warn.mockRestore();
    }
  });

  it('tracks text dispatch per turn across consecutive turns', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: OBSERVATION_XML }]),
      resultFrame(),
      assistantFrame([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    // Turn one stored, turn two produced no text and took the idle hand-off:
    // the flag must not stay latched from the first turn.
    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(2);
  });

  it('re-queues the claimed batch when a textless turn ends on an SDK error (#3869)', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'thinking', thinking: 'considering the batch', signature: 'sig' }]),
      resultFrame({ subtype: 'error_during_execution', is_error: true }),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).not.toHaveBeenCalled();
    expect(harness.confirmClaimedMessages).not.toHaveBeenCalled();
    expect(harness.resetProcessingToPending).toHaveBeenCalledTimes(1);
    expect(harness.remainingClaimed()).toHaveLength(1);
    // The scripted stream ends after the failed turn, with nothing answering
    // the re-sent batch: that exit is named so GeneratorExitHandler keeps the
    // session instead of finalizing the batch away.
    expect(session.abortReason).toBe('transport:sdk_eof');
  });
});

describe('ClaudeProvider invalid API key detection (#4253)', () => {
  beforeEach(() => {
    sdkFixture.messages = [];
  });

  it('stores an observation that quotes "Invalid API key" mid-content', async () => {
    const session = createSession();
    const harness = createHarness(session);
    const quotingXml = OBSERVATION_XML.replace(
      'The queued batch reached the parser.',
      'The login test asserted the CLI prints "Invalid API key" for a revoked key.',
    );

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: quotingXml }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    expect(harness.confirmClaimedMessages).toHaveBeenCalledTimes(1);
  });

  it('does not throw on a reply that puts ordinary narrative after an "Invalid API key ·" prefix', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: 'Invalid API key · the login test covers the revoked-key path.' }]),
      resultFrame(),
    ];

    await expect(harness.provider.startSession(session)).resolves.toBeUndefined();
  });

  it('still throws when the CLI answers with its invalid API key status line', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      { ...assistantFrame([{ type: 'text', text: 'Invalid API key · Fix external API key' }]), error: 'authentication_failed' },
      resultFrame({ is_error: true }),
    ];

    await expect(harness.provider.startSession(session)).rejects.toThrow('Invalid API key');
    expect(harness.storeObservations).not.toHaveBeenCalled();
  });
});

describe('ClaudeProvider model refusal detection (#5315)', () => {
  const REFUSAL = "There's an issue with the selected model (auto). It may not exist or you may not have access to it. Run --model to pick a different model.";

  beforeEach(() => {
    sdkFixture.messages = [];
  });

  it.each([
    ['the structured error', { error: 'model_not_found' }],
    ['the whole status line, from a CLI without the field', {}],
  ])('stops on %s without parsing the reply as prose', async (_name, extra) => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      { ...assistantFrame([{ type: 'text', text: REFUSAL }]), ...extra },
      resultFrame({ is_error: true }),
    ];

    const failure = await harness.provider.startSession(session).then(() => null, error => error);
    expect(failure).toMatchObject({ kind: 'unrecoverable', code: 'model_unavailable', message: REFUSAL });
    expect(failure.action).toContain('CLAUDE_MEM_MODEL');
    expect(harness.storeObservations).not.toHaveBeenCalled();
    expect(harness.confirmClaimedMessages).not.toHaveBeenCalled();
  });

  it('stores an observation that quotes the refusal', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: OBSERVATION_XML.replace('The queued batch reached the parser.', REFUSAL) }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
  });

  it('does not stop on narrative that opens with the same words', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: "There's an issue with the selected model (auto) in the settings test, which now passes." }]),
      resultFrame(),
    ];

    await expect(harness.provider.startSession(session)).resolves.toBeUndefined();
  });
});

describe('ClaudeProvider MEMORY_ID_CAPTURED spawn-health line (#4150)', () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    sdkFixture.messages = [];
    infoSpy = spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  function memoryIdLines(): string[] {
    return infoSpy.mock.calls
      .map(call => String(call[1]))
      .filter(message => message.startsWith('MEMORY_ID_CAPTURED') || message.startsWith('MEMORY_ID_CHANGED'));
  }

  it('is not logged for a spawn that only answers signed-out prose', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: 'Not logged in · Please run /login' }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    // The parser paused the generator and kept the batch; a log monitor must
    // not read this spawn as a live observer.
    expect(session.abortReason).toBe('auth:observer_text');
    expect(harness.resetProcessingToPending).toHaveBeenCalledTimes(1);
    expect(memoryIdLines()).toEqual([]);
  });

  it('is logged once the parser accepts real output', async () => {
    const session = createSession();
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: OBSERVATION_XML }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(harness.storeObservations).toHaveBeenCalledTimes(1);
    const lines = memoryIdLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`MEMORY_ID_CAPTURED | sessionDbId=3492 | memorySessionId=${MEMORY_SESSION_ID} |`);
  });
});

describe('ClaudeProvider per-turn usage visibility (#5023)', () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    sdkFixture.messages = [];
    infoSpy = spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('logs finalized result-frame counts once without including prompt content', async () => {
    const session = createSession();
    const harness = createHarness(session);
    const promptText = 'private observation prompt content';
    session.userPrompt = promptText;

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: OBSERVATION_XML }]),
      resultFrame({
        usage: {
          input_tokens: 101,
          cache_creation_input_tokens: 202,
          cache_read_input_tokens: 303,
          output_tokens: 40,
        },
      }),
    ];

    await harness.provider.startSession(session);

    const usageCalls = infoSpy.mock.calls.filter(call => call[1] === 'Observer turn usage');
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]?.[2]).toEqual({
      sessionId: 3492,
      promptNumber: 2,
      inputTokens: 101,
      cacheCreationInputTokens: 202,
      cacheReadInputTokens: 303,
      fullContextTokens: 606,
      outputTokens: 40,
    });
    expect(JSON.stringify(usageCalls[0])).not.toContain(promptText);
  });

  it('does not log usage for the synthetic init result', async () => {
    const session = createSession();
    session.lastGeneratorSource = 'init';
    const harness = createHarness(session);

    sdkFixture.messages = [
      assistantFrame([{ type: 'text', text: OBSERVATION_XML }]),
      resultFrame(),
    ];

    await harness.provider.startSession(session);

    expect(infoSpy.mock.calls.filter(call => call[1] === 'Observer turn usage')).toHaveLength(0);
  });
});
