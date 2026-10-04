import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  pruneProcessedObservationPayloads,
  KEEP_RECENT_MESSAGES,
  MIN_PRUNABLE_CHARS,
} from '../src/services/worker/history-pruning.js';
import { buildContinuationPrompt, buildObservationPrompt, SUMMARY_MODE_MARKER } from '../src/sdk/prompts.js';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import type { ModeConfig } from '../src/services/domain/types.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../src/services/worker/OpenAICompatibleProvider.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession, ConversationMessage } from '../src/services/worker-types.js';

const CODE_MODE = JSON.parse(readFileSync(join(import.meta.dir, '../plugin/modes/code.json'), 'utf8')) as ModeConfig;

const INIT_PROMPT = 'You are an observer.\n<observed_from_primary_session>\n  <user_request>build the thing</user_request>\n</observed_from_primary_session>\n' + 'x'.repeat(2000);

function observationMessage(tool: string, filler: string): ConversationMessage {
  return {
    role: 'user',
    content: buildObservationPrompt({
      id: 0,
      tool_name: tool,
      tool_input: JSON.stringify({ file_path: `/repo/${tool}.ts` }),
      tool_output: JSON.stringify({ content: filler }),
      created_at_epoch: 1700000000000,
      cwd: '/repo',
    }),
  };
}

function assistantMessage(): ConversationMessage {
  return { role: 'assistant', content: '<observation><type>discovery</type><title>Found it</title></observation>' };
}

function buildHistory(exchanges: number): ConversationMessage[] {
  const history: ConversationMessage[] = [{ role: 'user', content: INIT_PROMPT }];
  for (let i = 0; i < exchanges; i++) {
    history.push(observationMessage('Read', `payload ${i} ` + 'y'.repeat(5000)));
    history.push(assistantMessage());
  }
  return history;
}

describe('pruneProcessedObservationPayloads', () => {
  it('stubs old observation payloads and keeps role, tool name, and timestamp', () => {
    const history = buildHistory(10); // 21 messages, indices 1..12 outside keep window
    const pruned = pruneProcessedObservationPayloads(history);

    expect(pruned).toBeGreaterThan(0);
    const stub = history[1];
    expect(stub.role).toBe('user');
    expect(stub.content).toContain('pruned="true"');
    expect(stub.content).toContain('<what_happened>Read</what_happened>');
    expect(stub.content).toContain('2023-11-14'); // from created_at_epoch
    expect(stub.content).not.toContain('yyyy');
    expect(stub.content.length).toBeLessThan(MIN_PRUNABLE_CHARS);
  });

  it('never touches the init prompt, assistant messages, or the recent window', () => {
    const history = buildHistory(10);
    const before = history.map(m => m.content);
    pruneProcessedObservationPayloads(history);

    // init prompt intact
    expect(history[0].content).toBe(before[0]);
    // assistant messages intact everywhere
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'assistant') {
        expect(history[i].content).toBe(before[i]);
      }
    }
    // trailing window intact
    for (let i = history.length - KEEP_RECENT_MESSAGES; i < history.length; i++) {
      expect(history[i].content).toBe(before[i]);
    }
  });

  it('skips summary prompts and small messages', () => {
    const history = buildHistory(8);
    const summary: ConversationMessage = {
      role: 'user',
      content: `--- ${SUMMARY_MODE_MARKER} ---\n<observed_from_primary_session>\n` + 'z'.repeat(2000),
    };
    const small: ConversationMessage = { role: 'user', content: '<observed_from_primary_session>tiny</observed_from_primary_session>' };
    history.splice(3, 0, summary, small);

    pruneProcessedObservationPayloads(history);

    expect(history[3].content).toContain(SUMMARY_MODE_MARKER);
    expect(history[3].content).toContain('zzz');
    expect(history[4].content).toBe(small.content);
  });

  it('is idempotent: a second pass prunes nothing', () => {
    const history = buildHistory(10);
    const first = pruneProcessedObservationPayloads(history);
    const second = pruneProcessedObservationPayloads(history);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('bounds total history size as exchanges grow', () => {
    const history = buildHistory(40); // 81 messages, ~5k chars per payload
    const beforeChars = history.reduce((sum, m) => sum + m.content.length, 0);
    pruneProcessedObservationPayloads(history);
    const afterChars = history.reduce((sum, m) => sum + m.content.length, 0);

    // Everything outside init + recent window collapses to stubs.
    expect(afterChars).toBeLessThan(beforeChars / 5);
    // Chronology and count preserved: nothing is removed, only shrunk.
    expect(history.length).toBe(81);
  });

  it('does nothing on short histories that fit the recent window', () => {
    const history = buildHistory(3); // 7 messages <= 1 + KEEP_RECENT_MESSAGES
    const pruned = pruneProcessedObservationPayloads(history);
    expect(pruned).toBe(0);
  });

  it('never stubs an init or continuation prompt that sits mid-history', () => {
    const history = buildHistory(10);
    const continuation: ConversationMessage = {
      role: 'user',
      content: buildContinuationPrompt('keep going', 3, 'content-3151', CODE_MODE, 'Earlier: fixed the parser.'),
    };
    // Far outside the recent window, where a payload this size is stubbed.
    history.splice(3, 0, continuation);
    const original = continuation.content;
    expect(original.length).toBeGreaterThan(MIN_PRUNABLE_CHARS);

    const pruned = pruneProcessedObservationPayloads(history);

    expect(pruned).toBeGreaterThan(0);
    expect(history[3].content).toBe(original);
    expect(history[3].content).toContain('<user_request>keep going</user_request>');
    // The tool payload before it was still stubbed.
    expect(history[1].content).toContain('pruned="true"');
  });
});

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
 * Records the size of every request. Replies are non-XML, so
 * processAgentResponse confirms and returns without touching storage.
 */
class RecordingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  readonly requestChars: number[] = [];
  private turn = 0;

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    this.requestChars.push(history.reduce((sum, message) => sum + message.content.length, 0));
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
      })),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    mock.restore();
  });

  it(`keeps every reply once and pays only a stub per old payload over ${TURNS} turns`, async () => {
    const messages = Array.from({ length: TURNS }, (_, i) => ({
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: `/repo/file-${i}.ts` },
      tool_response: `${i}:`.padEnd(PAYLOAD_CHARS, 'y'),
      prompt_number: 2,
    }));
    const sessionManager = {
      getMessageIterator: async function* () {
        yield* messages;
      },
      confirmClaimedMessages: async () => {},
      resetProcessingToPending: async () => {},
      getClaimedMessages: () => [],
    };
    const provider = new RecordingProvider({} as never, sessionManager as never);
    const session = makeSession();

    await provider.startSession(session);

    // One request per turn (the init prompt rides on the first): the
    // generation never had to recycle.
    expect(provider.requestChars).toHaveLength(TURNS);
    expect(session.abortReason ?? null).toBeNull();
    // Every reply sits in the history exactly once, in order.
    expect(session.conversationHistory.filter(message => message.role === 'assistant').map(message => message.content))
      .toEqual(Array.from({ length: TURNS }, (_, i) => `REPLY_${i}`));
    // Past the verbatim window a turn adds a stub and a reply, never a payload,
    // so the request grows by a few hundred chars a turn instead of ~5k.
    const growthPerTurn = (provider.requestChars[TURNS - 1] - provider.requestChars[TURNS - 101]) / 100;
    expect(growthPerTurn).toBeLessThan(MIN_PRUNABLE_CHARS);
  }, 30_000);
});
