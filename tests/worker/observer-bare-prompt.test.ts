import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { ClaudeProvider } from '../../src/services/worker/ClaudeProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

// A generator used to open with a request carrying only the user's prompt
// (<user_request>) and the observer's instructions. With no tool call to
// observe, the model nearly always answered <skip_summary reason="noise" />:
// a full prefill per prompt for a nine-token reply. The prompt is context for
// the next tool observation, so it now rides on that request instead.

const PROMPT = 'fix the login redirect';

const observationXml = `<observation>
  <type>discovery</type>
  <title>Read the router</title>
  <narrative>The login redirect lives in the router.</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>`;

const summaryXml = `<summary>
  <request>${PROMPT}</request>
  <investigated>router</investigated>
  <learned>redirect</learned>
  <completed>nothing yet</completed>
  <next_steps>fix it</next_steps>
  <notes></notes>
</summary>`;

type QueuedMessage = Record<string, unknown>;

const readEvent = (file: string): QueuedMessage => ({
  type: 'observation',
  tool_name: 'Read',
  tool_input: { file_path: file },
  tool_response: `contents of ${file}`,
  prompt_number: 1,
});

const summarizeEvent: QueuedMessage = { type: 'summarize', last_assistant_message: 'Looked at the router.' };

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'bare-prompt-session',
    memorySessionId: 'mem-session-1',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: PROMPT,
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  };
}

/** Records every request in the shape it goes out on the wire. */
class RecordingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'RecordingProvider';
  protected readonly syntheticIdPrefix = 'recording';
  protected readonly forwardEmptyMessageResponse = false;
  readonly requests: Array<Array<{ role: string; content: string }>> = [];

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'test-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    const messages = this.conversationToOpenAIMessages(history);
    this.requests.push(messages);
    const last = history[history.length - 1].content;
    return { content: last.includes('<summary>') ? summaryXml : observationXml, tokensUsed: 10 };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

/** The user-turn text of one recorded request. */
function userText(request: Array<{ role: string; content: string }>): string {
  return request.filter(message => message.role === 'user').map(message => message.content).join('\n');
}

describe('a bare user prompt does not cost an observer call', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let dbManager: DatabaseManager;
  let previousSetting: string | undefined;

  function sessionManagerYielding(events: QueuedMessage[]): SessionManager {
    return {
      getMessageIterator: async function* () {
        for (const event of events) yield event;
      },
      getClaimedMessages: mock(() => []),
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;
  }

  beforeEach(() => {
    previousSetting = process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
    delete process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;

    // The real mode, so the init prompt carries the real <user_request> block.
    const realMode = ModeManager.getInstance().loadMode('code');
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => realMode,
      loadMode: () => {},
    } as unknown as ModeManager));

    dbManager = {
      getSessionStore: () => ({
        storeObservations: mock(() => ({ observationIds: [1], summaryId: 1, createdAtEpoch: Date.now() })),
        ensureMemorySessionIdRegistered: mock(() => {}),
        updateMemorySessionId: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
      }),
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
      getChromaSync: () => ({
        syncObservation: mock(() => Promise.resolve()),
        syncSummary: mock(() => Promise.resolve()),
      }),
      getCloudSync: () => null,
    } as unknown as DatabaseManager;
  });

  afterEach(() => {
    if (previousSetting === undefined) delete process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
    else process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = previousSetting;
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it('defaults CLAUDE_MEM_OBSERVE_BARE_PROMPTS to false', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OBSERVE_BARE_PROMPTS).toBe('false');
  });

  it('sends nothing for a prompt with no tool event behind it', async () => {
    const provider = new RecordingProvider(dbManager, sessionManagerYielding([]));
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.requests).toHaveLength(0);
    // The prompt still opens the generation, ready for the next tool event.
    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0].content).toContain(`<user_request>${PROMPT}</user_request>`);
  });

  it('carries the prompt on the following tool event, in one request', async () => {
    const provider = new RecordingProvider(dbManager, sessionManagerYielding([readEvent('src/router.ts')]));
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.requests).toHaveLength(1);
    const [request] = provider.requests;
    expect(request[0].role).toBe('system');
    expect(request.filter(message => message.role === 'user')).toHaveLength(1);
    expect(userText(request)).toContain(`<user_request>${PROMPT}</user_request>`);
    expect(userText(request)).toContain('<what_happened>Read</what_happened>');
    expect(userText(request)).toContain('src/router.ts');
    expect(session.conversationHistory.map(message => message.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('does not call the observer for the prompt when only a summary follows', async () => {
    const provider = new RecordingProvider(dbManager, sessionManagerYielding([summarizeEvent]));
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.requests).toHaveLength(1);
    expect(userText(provider.requests[0])).toContain('<summary>');
  });

  it('a prompt with several tool events and a summary costs one call per event, as before', async () => {
    const events = [readEvent('src/router.ts'), readEvent('src/login.ts'), summarizeEvent];
    const provider = new RecordingProvider(dbManager, sessionManagerYielding(events));
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.requests).toHaveLength(3);
    expect(userText(provider.requests[0])).toContain(`<user_request>${PROMPT}</user_request>`);
    expect(userText(provider.requests[0])).toContain('src/router.ts');
    expect(userText(provider.requests[1])).toContain('src/login.ts');
    expect(userText(provider.requests[2])).toContain('<summary>');
  });

  it('CLAUDE_MEM_OBSERVE_BARE_PROMPTS=true restores the call per prompt', async () => {
    process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = 'true';
    const provider = new RecordingProvider(dbManager, sessionManagerYielding([readEvent('src/router.ts')]));
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.requests).toHaveLength(2);
    expect(userText(provider.requests[0])).toContain(`<user_request>${PROMPT}</user_request>`);
    expect(userText(provider.requests[0])).not.toContain('<what_happened>');
    expect(session.conversationHistory.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  describe('Claude SDK feed', () => {
    const answeringPacer = { mark: () => 0, waitForAnswer: async () => 'answered' };

    async function feed(events: QueuedMessage[]): Promise<{ prompts: string[]; session: ActiveSession }> {
      const provider = new ClaudeProvider(dbManager, sessionManagerYielding(events)) as any;
      const session = makeSession();
      const prompts: string[] = [];
      const generator = provider.createMessageGenerator(
        session, { lastCwd: undefined }, { current: null }, undefined, undefined, answeringPacer,
      );
      for await (const message of generator) prompts.push(String(message.message.content));
      return { prompts, session };
    }

    it('yields nothing for a prompt with no tool event behind it', async () => {
      const { prompts } = await feed([]);
      expect(prompts).toHaveLength(0);
    });

    it('sends the prompt with the first tool event as one message', async () => {
      const { prompts, session } = await feed([readEvent('src/router.ts'), readEvent('src/login.ts')]);

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain(`<user_request>${PROMPT}</user_request>`);
      expect(prompts[0]).toContain('src/router.ts');
      expect(prompts[1]).not.toContain('<user_request>');
      expect(prompts[1]).toContain('src/login.ts');
      expect(session.lastGeneratorSource).toBe('ingest');
    });

    it('sends the prompt with a summary when no tool event came first', async () => {
      const { prompts } = await feed([summarizeEvent]);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(`<user_request>${PROMPT}</user_request>`);
      expect(prompts[0]).toContain('<summary>');
    });

    it('CLAUDE_MEM_OBSERVE_BARE_PROMPTS=true restores the separate prompt turn', async () => {
      process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = 'true';
      const { prompts } = await feed([readEvent('src/router.ts')]);

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain(`<user_request>${PROMPT}</user_request>`);
      expect(prompts[0]).not.toContain('src/router.ts');
      expect(prompts[1]).toContain('src/router.ts');
    });
  });
});
