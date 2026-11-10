import { expect, it } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { paidSendOutcomeOf } from '../../src/services/worker/provider-errors.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

const primary = '<observation><type>discovery</type><title>Primary result</title><narrative>Chosen answer.</narrative></observation>';
const alternative = '<observation><type>discovery</type><title>Alternative result</title><narrative>Different answer.</narrative></observation>';
const choice = (index: number | undefined, content: string, finish_reason: string | null = null) =>
  ({ ...(index === undefined ? {} : { index }), delta: { content }, finish_reason });
const frame = (...choices: ReturnType<typeof choice>[]) => `data: ${JSON.stringify({ model: 'owned/model', choices })}\n\n`;
const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`;

class OwnedProvider extends OpenRouterProvider {
  constructor() { super({} as never, {} as never); }
  ask(apiUrl: string, budget: PaidSendBudget): Promise<ProviderQueryResult> {
    return this.query([{ role: 'user', content: 'Remember the supplied change.' }], {
      apiKey: 'owned-key', apiKeys: ['owned-key'], model: 'owned/model', fallbackModels: [], apiUrl,
      extraBody: { n: 2 },
    } as never, undefined, undefined, budget);
  }
}

async function withReply(body: string, run: (url: string, requests: Record<string, unknown>[]) => Promise<void>) {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as Record<string, unknown>);
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  try { await run(new URL('/v1/chat/completions', server.url).href, requests); }
  finally { await server.stop(true); }
}

async function storedTitles(result: ProviderQueryResult): Promise<string[]> {
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const sessionDbId = store.createSDKSession('owned-stream-choice', 'owned-project', 'Remember this.');
    const session = { sessionDbId, contentSessionId: 'owned-stream-choice', memorySessionId: 'owned-memory-choice',
      project: 'owned-project', platformSource: 'claude', userPrompt: 'Remember this.', abortController: new AbortController(),
      generatorPromise: null, lastPromptNumber: 1, startTime: Date.now(), cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0, earliestPendingTimestamp: 1, claimedMessageIds: [], conversationHistory: [],
      currentProvider: 'openrouter', consecutiveRestarts: 0, consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0, lastGeneratorActivity: Date.now(), lastFinishReason: result.finishReason,
    } as ActiveSession;
    await processAgentResponse(result.content, session,
      { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null } as never,
      { getClaimedMessages: () => [], confirmClaimedMessages: async () => 0 } as never,
      undefined, result.tokensUsed ?? 0, Date.now(), 'OpenRouter');
    return (store.db.query('SELECT title FROM observations ORDER BY id').all() as Array<{ title: string }>).map(row => row.title);
  } finally { store.close(); }
}

for (const packing of ['separate', 'same-frame']) {
  it(`stores only choice zero from ${packing} interleaved alternatives`, async () => {
    const body = packing === 'separate'
      ? frame(choice(1, alternative)) + frame(choice(0, primary)) + frame(choice(0, '', 'stop')) + frame(choice(1, '', 'length'))
      : frame(choice(1, alternative), choice(0, primary)) + frame(choice(1, '', 'length'), choice(0, '', 'stop'));
    await withReply(body + usage + 'data: [DONE]\n\n', async (url, requests) => {
      const budget = new PaidSendBudget(1);
      const result = await new OwnedProvider().ask(url, budget);
      expect(await storedTitles(result)).toEqual(['Primary result']);
      expect(result.content).toBe(primary);
      expect(result.finishReason).toBe('stop');
      expect(result).toMatchObject({ inputTokens: 10, outputTokens: 20, tokensUsed: 30 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ n: 2, stream: true });
      expect(budget.spentPaidSends).toBe(1);
    });
  });
}

it('does not let another choice finish an incomplete primary answer', async () => {
  await withReply(frame(choice(0, '<observation>')) + frame(choice(1, '', 'stop')), async (url, requests) => {
    const budget = new PaidSendBudget(1);
    const error = await new OwnedProvider().ask(url, budget).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
    expect(requests).toHaveLength(1);
    expect(budget.spentPaidSends).toBe(1);
  });
});

it('retains billed output from an unselected choice without a paid resend', async () => {
  await withReply(frame(choice(0, ''), choice(1, 'Already generated.')), async (url, requests) => {
    const budget = new PaidSendBudget(1);
    const error = await new OwnedProvider().ask(url, budget).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
    expect(requests).toHaveLength(1);
    expect(budget.spentPaidSends).toBe(1);
  });
});

it('retains billed reasoning_details from an unselected choice without a paid resend', async () => {
  const reasoningOnly = `data: ${JSON.stringify({ model: 'owned/model', choices: [
    { index: 0, delta: { content: '' }, finish_reason: null },
    { index: 1, delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Weighing it.', index: 0 }] }, finish_reason: null },
  ] })}\n\n`;
  await withReply(reasoningOnly, async (url, requests) => {
    const budget = new PaidSendBudget(1);
    const error = await new OwnedProvider().ask(url, budget).catch(error => error);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
    expect(requests).toHaveLength(1);
  });
});

it('keeps the existing single-choice compatibility when the index is omitted', async () => {
  await withReply(frame(choice(undefined, primary, 'stop')) + usage + 'data: [DONE]\n\n', async (url, requests) => {
    expect((await new OwnedProvider().ask(url, new PaidSendBudget(1))).content).toBe(primary);
    expect(requests).toHaveLength(1);
  });
});
