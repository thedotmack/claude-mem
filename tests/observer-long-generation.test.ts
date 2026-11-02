import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ModeManager } from '../src/services/domain/ModeManager.js';
import type { ModeConfig } from '../src/services/domain/types.js';
import { OpenAICompatibleProvider, type OpenAIChatMessage, type ObserverRequestLabel, type ProviderQueryResult } from '../src/services/worker/OpenAICompatibleProvider.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession, ConversationMessage } from '../src/services/worker-types.js';

const CODE_MODE = JSON.parse(readFileSync(join(import.meta.dir, '../plugin/modes/code.json'), 'utf8')) as ModeConfig;

function makeSession(): ActiveSession {
  return {
    sessionDbId: 3151,
    contentSessionId: 'content-3151',
    memorySessionId: 'mem-3151',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
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
  } as ActiveSession;
}

/**
 * Records independent snapshots of the serialized wire messages. Replies are non-XML, so
 * processAgentResponse confirms and returns without touching storage.
 */
class RecordingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  readonly requestChars: number[] = [];
  readonly requests: Array<{ messages: OpenAIChatMessage[]; generationId?: string }> = [];
  private turn = 0;

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(
    history: ConversationMessage[],
    _config: { apiKey: string; model: string },
    _signal?: AbortSignal,
    _timeout?: number,
    _paidSendBudget?: unknown,
    label?: ObserverRequestLabel,
  ): Promise<ProviderQueryResult> {
    this.requestChars.push(history.reduce((sum, message) => sum + message.content.length, 0));
    this.requests.push({
      messages: JSON.parse(JSON.stringify(this.conversationToOpenAIMessages(history))),
      generationId: label?.generationId,
    });
    return { content: `REPLY_${this.turn++}` };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

describe('observer requests across a long generation', () => {
  const TURNS = 200;
  const PAYLOAD_CHARS = 5_000;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    spies = [
      spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
        getActiveMode: () => CODE_MODE,
        loadMode: () => {},
      }) as never),
      spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
        CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW: '200000',
      })),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    mock.restore();
  });

  function messages(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: `/repo/file-${i}.ts` },
      tool_response: `${i}:`.padEnd(PAYLOAD_CHARS, 'y'),
      prompt_number: 2,
    }));
  }

  function makeQueue(session: ActiveSession, messages: unknown[]) {
    const pending = [...messages];
    return {
      pending,
      getMessageIterator: async function* () {
        while (pending.length > 0 && !session.abortController.signal.aborted) {
          yield pending[0];
        }
      },
      confirmClaimedMessages: async () => { pending.shift(); },
      resetProcessingToPending: async () => {},
      getClaimedMessages: () => [],
    };
  }

  it('preserves every previously sent wire message beyond the old pruning horizon, including a summary', async () => {
    const session = makeSession();
    const queue = makeQueue(session, [
      ...messages(40),
      { type: 'summarize', last_assistant_message: 'all forty files inspected' },
    ]);
    const provider = new RecordingProvider({} as never, queue as never);

    await provider.startSession(session);

    expect(provider.requests).toHaveLength(41);
    expect(session.abortReason ?? null).toBeNull();
    // The old implementation rewrote the first payload at request five. A
    // deep-copied wire body catches it even if the original arrays mutate.
    for (let i = 1; i < provider.requests.length; i++) {
      const previous = provider.requests[i - 1].messages;
      expect(provider.requests[i].messages.slice(0, previous.length)).toEqual(previous);
    }
    const summaryMessages = provider.requests.at(-1)!.messages;
    expect(summaryMessages[1].content).toContain('0:'.padEnd(PAYLOAD_CHARS, 'y'));
    expect(summaryMessages.some(message => message.content.includes('pruned="true"'))).toBe(false);
    // Every reply sits in the history exactly once, in order.
    expect(session.conversationHistory.filter(message => message.role === 'assistant').map(message => message.content))
      .toEqual(Array.from({ length: 41 }, (_, i) => `REPLY_${i}`));
    expect(queue.pending).toHaveLength(0);
  }, 30_000);

  it(`retains raw payloads within each generation and drains ${TURNS} turns through bounded recycling`, async () => {
    const session = makeSession();
    const queue = makeQueue(session, messages(TURNS));
    const provider = new RecordingProvider({} as never, queue as never);
    let generations = 0;
    while (queue.pending.length > 0 && generations < 10) {
      session.abortController = new AbortController();
      session.abortReason = null;
      await provider.startSession(session);
      generations++;
    }

    expect(queue.pending).toHaveLength(0);
    expect(provider.requests).toHaveLength(TURNS);
    expect(generations).toBeGreaterThan(1);
    expect(Math.max(...provider.requestChars)).toBeLessThan(410_000);
    expect(new Set(provider.requests.map(request => request.generationId)).size).toBe(generations);
    for (let i = 1; i < provider.requests.length; i++) {
      const previous = provider.requests[i - 1];
      const current = provider.requests[i];
      if (previous.generationId === current.generationId) {
        expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
      }
    }
  }, 30_000);
});
