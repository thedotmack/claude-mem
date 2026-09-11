import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { logger } from '../../src/utils/logger.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

/**
 * Regression guard for the duplicate-assistant-history bug fixed upstream at
 * #3619 (predates #3606; OpenAICompatibleProvider no longer pushes the
 * assistant reply itself — processAgentResponse in ResponseProcessor.ts
 * already does). Exercises the full startSession() flow (init + two
 * observation rounds) through OpenRouterProvider — the only concrete
 * OpenAICompatibleProvider subclass this change touches — with a mocked
 * fetch, and asserts conversationHistory ends up with exactly one assistant
 * entry per reply, alternating roles.
 */

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

function observationXml(title: string): string {
  return `<observation><type>discovery</type><title>${title}</title><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAICompatibleProvider — no duplicate assistant history entries (#3606/#3619)', () => {
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'mock-model',
    }));
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));
    loggerSpies = [
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'success').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    loadFromFileSpy.mockRestore();
    modeManagerSpy.mockRestore();
    loggerSpies.forEach(s => s.mockRestore());
    mock.restore();
  });

  it('records exactly one assistant entry per reply across init + two observation rounds', async () => {
    let call = 0;
    const replies = [observationXml('init'), observationXml('obs-1'), observationXml('obs-2')];
    const fetchMock = mock(() => {
      const content = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return Promise.resolve(jsonResponse({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const observationMessages = [
      { type: 'observation', tool_name: 'Read', tool_input: { file: 'a.ts' }, tool_response: 'r1', prompt_number: 1, cwd: '/tmp' },
      { type: 'observation', tool_name: 'Read', tool_input: { file: 'b.ts' }, tool_response: 'r2', prompt_number: 1, cwd: '/tmp' },
    ];

    const mockStoreObservations = mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }));
    const mockDbManager = {
      getSessionStore: () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'mem-session-123' })),
        updateMemorySessionId: mock(() => {}),
      }),
      getChromaSync: () => ({
        syncObservation: mock(() => Promise.resolve()),
        syncSummary: mock(() => Promise.resolve()),
      }),
      getCloudSync: () => null,
    } as unknown as DatabaseManager;

    const mockSessionManager = {
      getMessageIterator: async function* () {
        for (const m of observationMessages) yield m as any;
      },
      getClaimedMessages: mock(() => []),
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;

    const provider = new OpenRouterProvider(mockDbManager, mockSessionManager);

    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: null,
      project: 'test-project',
      platformSource: 'claude',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      consecutiveRestarts: 0,
      consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0,
      claimedMessageIds: [],
      earliestPendingTimestamp: null,
      lastGeneratorActivity: Date.now(),
      startTime: Date.now(),
    } as unknown as ActiveSession;

    await provider.startSession(session);

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const roles = session.conversationHistory.map(m => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);

    for (let i = 1; i < roles.length; i++) {
      const consecutiveAssistants = roles[i] === 'assistant' && roles[i - 1] === 'assistant';
      expect(consecutiveAssistants).toBe(false);
    }

    // Each assistant entry is the exact reply text once, not twice.
    expect(session.conversationHistory[1].content).toBe(replies[0]);
    expect(session.conversationHistory[3].content).toBe(replies[1]);
    expect(session.conversationHistory[5].content).toBe(replies[2]);
  });
});
