// The Claude observer sends one queued tool event per prompt and waits for
// the answer before sending the next. One busy session with many subagents
// queued 600-1060 events an hour; buffer samples put its observer's drain at
// about 275-430 an hour, and the backlog shrank only after intake dropped.
// CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE (opt-in, default 1) lets one
// prompt carry several queued events that share an attribution context, as
// the Codex provider already does with CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { ClaudeProvider } from '../../src/services/worker/ClaudeProvider.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { observationFieldMaxChars } from '../../src/services/worker/context-window.js';

const SETTING = 'CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE';

type QueuedMessage = Record<string, unknown>;

const readEvent = (file: string, overrides: QueuedMessage = {}): QueuedMessage => ({
  type: 'observation',
  tool_name: 'Read',
  tool_input: { file_path: file },
  tool_response: `contents of ${file}`,
  prompt_number: 1,
  ...overrides,
});

function makeSession(): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'batch-session',
    memorySessionId: 'mem-session-1',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'read the files',
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
 * A queue that already holds every event, as a backlog does. Like the real
 * buffer, the iterator and claimNextObservation both take from the FIFO head,
 * and claimNextObservation never skips a message it does not accept.
 */
function sessionManagerHolding(events: QueuedMessage[]): SessionManager {
  const queue = events.map((event, i) => ({ ...event, _persistentId: i + 1, _originalTimestamp: 1_000 + i }));
  return {
    getMessageIterator: async function* () {
      while (queue.length > 0) yield queue.shift();
    },
    claimNextObservation: mock((_sessionDbId: number, accepts: (m: QueuedMessage) => boolean) => {
      const head = queue[0];
      if (!head || head.type !== 'observation' || !accepts(head)) return null;
      return queue.shift();
    }),
    getClaimedMessages: mock(() => []),
    confirmClaimedMessages: mock(() => Promise.resolve(0)),
    resetProcessingToPending: mock(() => Promise.resolve(0)),
  } as unknown as SessionManager;
}

const files = (n: number) => Array.from({ length: n }, (_, i) => `src/file-${i}.ts`);
// Each event's tool output is unique text; the init prompt also names the tags, so count the outputs.
const eventsIn = (prompt: string) => prompt.split('contents of ').length - 1;

describe('Claude observer batches queued events', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let dbManager: DatabaseManager;
  let previous: string | undefined;
  const answeringPacer = { mark: () => 0, waitForAnswer: async () => 'answered' };

  async function feed(events: QueuedMessage[]): Promise<string[]> {
    const provider = new ClaudeProvider(dbManager, sessionManagerHolding(events)) as any;
    const prompts: string[] = [];
    const generator = provider.createMessageGenerator(
      makeSession(), { lastCwd: undefined }, { current: null }, undefined, undefined, answeringPacer,
    );
    for await (const message of generator) prompts.push(String(message.message.content));
    return prompts;
  }

  beforeEach(() => {
    previous = process.env[SETTING];
    const realMode = ModeManager.getInstance().loadMode('code');
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => realMode,
      loadMode: () => {},
    } as unknown as ModeManager));
    dbManager = {
      getSessionStore: () => ({
        ensureMemorySessionIdRegistered: mock(() => {}),
        updateMemorySessionId: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
      }),
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
    } as unknown as DatabaseManager;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[SETTING];
    else process.env[SETTING] = previous;
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it('sends 8 queued events in 2 prompts when the batch size is 4', async () => {
    process.env[SETTING] = '4';
    const prompts = await feed(files(8).map(f => readEvent(f)));

    expect(prompts).toHaveLength(2);
    expect(prompts.map(eventsIn)).toEqual([4, 4]);
    for (const f of files(8)) expect(prompts.join('\n')).toContain(f);
  });

  it('keeps one event per prompt when the setting is not set (default 1)', async () => {
    delete process.env[SETTING];
    const prompts = await feed(files(3).map(f => readEvent(f)));

    expect(prompts.map(eventsIn)).toEqual([1, 1, 1]);
  });

  it('keeps one event per prompt when the batch size is 1', async () => {
    process.env[SETTING] = '1';
    const prompts = await feed(files(3).map(f => readEvent(f)));

    expect(prompts.map(eventsIn)).toEqual([1, 1, 1]);
  });

  it('never mixes events from different subagents in one prompt', async () => {
    process.env[SETTING] = '4';
    const prompts = await feed([
      readEvent('a1.ts', { agentId: 'agent-a', agentType: 'general-purpose' }),
      readEvent('a2.ts', { agentId: 'agent-a', agentType: 'general-purpose' }),
      readEvent('b1.ts', { agentId: 'agent-b', agentType: 'general-purpose' }),
      readEvent('b2.ts', { agentId: 'agent-b', agentType: 'general-purpose' }),
    ]);

    expect(prompts.map(eventsIn)).toEqual([2, 2]);
    expect(prompts[0]).toContain('a2.ts');
    expect(prompts[0]).not.toContain('b1.ts');
  });

  it('never puts a summary request in the same prompt as observations', async () => {
    process.env[SETTING] = '4';
    const prompts = await feed([
      readEvent('x.ts'),
      { type: 'summarize', last_assistant_message: 'done' },
      readEvent('y.ts'),
    ]);

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('<summary>');
    expect(eventsIn(prompts[1])).toBe(0);
  });

  it('carries 8 events in every prompt of a 1000-event backlog', async () => {
    process.env[SETTING] = '8';
    const prompts = await feed(files(1000).map(f => readEvent(f)));

    // One generation stops at its conversation budget and a fresh one takes
    // the rest; until then each prompt carries a full batch, so the backlog
    // needs ceil(1000/8) prompts instead of 1000.
    expect(prompts.length).toBeGreaterThan(10);
    expect(new Set(prompts.map(eventsIn))).toEqual(new Set([8]));
  });

  it('ends a batch at an event whose field is over the cap, so it is condensed on its own', async () => {
    process.env[SETTING] = '4';
    const cap = observationFieldMaxChars(undefined);
    const prompts = await feed([
      readEvent('small-0.ts'),
      readEvent('huge.ts', { tool_response: 'contents of huge '.padEnd(cap + 100, 'x') }),
      readEvent('small-2.ts'),
    ]);

    expect(eventsIn(prompts[0])).toBe(1);
    expect(prompts[0]).not.toContain('huge.ts');
    expect(prompts[1]).toContain('huge.ts');
  });

  it('never grows a prompt past two capped fields by adding queued events', async () => {
    process.env[SETTING] = '32';
    const cap = observationFieldMaxChars(undefined);
    const big = (i: number) => readEvent(`big-${i}.ts`, { tool_response: `contents of big ${i} `.padEnd(Math.floor(cap * 0.6), 'y') });
    const prompts = await feed([0, 1, 2, 3, 4, 5].map(big));

    // Without the budget all 6 would ride on one prompt.
    expect(Math.max(...prompts.map(eventsIn))).toBeLessThan(6);
    expect(prompts.reduce((n, p) => n + eventsIn(p), 0)).toBe(6);
    // The first prompt also carries the init prompt; the rest are batches alone.
    for (const p of prompts.slice(1)) expect(p.length).toBeLessThanOrEqual(2 * cap);
  });
});
