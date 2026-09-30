import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import type { ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';

// #3479: a generator start never continues the previous conversation (an HTTP
// provider re-sends whatever history it holds, and the Claude observer never
// resumes), yet each start used to append its init prompt to the old history.
// Across a quota, auth or transport retry loop that history grew without bound
// (one field report: a 40 GB worker). Every start now opens a new generation,
// so after any number of restarts the history holds exactly one generation.
// The Claude half of this lives in claude-provider-response-pacing.test.ts,
// which already drives the real ClaudeProvider against a fake SDK.

// bun's mock.module is process-global and sticky; snapshot and restore it.
const actualContextGenerator = { ...(await import('../../src/services/context-generator.js')) };
mock.module('../../src/services/context-generator.js', () => ({
  ...actualContextGenerator,
  generateContext: async () => '',
}));
afterAll(() => {
  mock.module('../../src/services/context-generator.js', () => actualContextGenerator);
});

const { ModeManager } = await import('../../src/services/domain/ModeManager.js');
const { OpenAICompatibleProvider } = await import('../../src/services/worker/OpenAICompatibleProvider.js');
const { ClassifiedProviderError } = await import('../../src/services/worker/provider-errors.js');
const { handleGeneratorExit } = await import('../../src/services/worker/session/GeneratorExitHandler.js');
const { logger } = await import('../../src/utils/logger.js');

const RESTARTS = 1_000;

type FailureKind = 'quota_exhausted' | 'auth_invalid' | 'transient';
type FailurePoint = 'init' | 'observation';

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

function makeSession(): ActiveSession {
  return {
    sessionDbId: 3479,
    contentSessionId: 'content-3479',
    memorySessionId: 'mem-3479',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 2,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: 'openrouter',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

/** Answers the init prompt, then fails the way a paused provider does. */
class FailingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;

  constructor(
    dbManager: never,
    sessionManager: never,
    private readonly failureKind: FailureKind,
    private readonly failurePoint: FailurePoint,
  ) {
    super(dbManager, sessionManager);
  }

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    const answeringInit = history.length === 1;
    if (answeringInit && this.failurePoint === 'observation') {
      return { content: 'ready', tokensUsed: 10 };
    }
    throw new ClassifiedProviderError(`provider paused (${this.failureKind})`, { kind: this.failureKind });
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

function makeSessionManager() {
  return {
    getMessageIterator: async function* () {
      yield { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/main.ts' }, tool_response: 'file contents', prompt_number: 2 };
    },
    getMessageBuffer: () => ({ getPendingCount: () => 1 }),
    resetProcessingToPending: async () => 0,
    removeSessionImmediate: mock(() => {}),
  };
}

const EXPECTED_ROLES: Record<FailurePoint, string[]> = {
  // The unanswered init prompt of the last attempt, and nothing before it.
  init: ['user'],
  // The last attempt's init turn plus its unanswered observation prompt.
  observation: ['user', 'assistant', 'user'],
};

describe('every HTTP generator start opens a new generation (#3479)', () => {
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    spies = [
      spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
        getActiveMode: () => mockMode,
        loadMode: () => {},
      }) as never),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    mock.restore();
  });

  const cases: Array<[FailureKind, FailurePoint, string]> = [
    ['quota_exhausted', 'observation', 'quota'],
    ['auth_invalid', 'observation', 'auth'],
    ['transient', 'observation', 'transport'],
    ['quota_exhausted', 'init', 'quota'],
    ['auth_invalid', 'init', 'auth'],
    ['transient', 'init', 'transport'],
  ];

  for (const [failureKind, failurePoint, exitCategory] of cases) {
    it(`${RESTARTS} ${exitCategory} restarts failing at ${failurePoint} leave exactly one generation`, async () => {
      const sessionManager = makeSessionManager();
      const finalizeSession = mock(() => Promise.resolve());
      const provider = new FailingProvider({} as never, sessionManager as never, failureKind, failurePoint);
      const session = makeSession();

      for (let attempt = 0; attempt < RESTARTS; attempt++) {
        session.abortController = new AbortController();
        session.abortReason = null;
        await expect(provider.startSession(session)).rejects.toThrow('provider paused');
        expect(session.abortReason).toStartWith(`${exitCategory}:`);
        await handleGeneratorExit(session, session.abortReason, {
          sessionManager: sessionManager as never,
          completionHandler: { finalizeSession } as never,
        });
      }

      // The session and its queue survived every pause...
      expect(finalizeSession).not.toHaveBeenCalled();
      expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
      // ...and the history holds the last attempt only: one init prompt, not 1,000.
      expect(session.conversationHistory.map(message => message.role)).toEqual(EXPECTED_ROLES[failurePoint]);
      expect(session.conversationHistory.filter(message => message.content.includes('<user_request>'))).toHaveLength(1);
    }, 30_000);
  }
});
