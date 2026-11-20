import { expect, it } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { paidSendOutcomeOf } from '../../src/services/worker/provider-errors.js';

const answer = '<observation><type>discovery</type><title>Completed answer</title></observation>';
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const complete = frame({ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] })
  + frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
  + 'data: [DONE]\n\n';

class Router extends OpenRouterProvider {
  constructor() { super({} as never, {} as never); }
  ask(apiUrl: string, budget: PaidSendBudget) {
    return this.query([{ role: 'user', content: 'Remember the supplied change.' }], {
      apiUrl, apiKey: 'owned-key', apiKeys: ['owned-key'], model: 'owned/model', fallbackModels: [],
    } as never, undefined, undefined, budget);
  }
}

class Compatible extends OpenAICompatProvider {
  constructor() { super({} as never, {} as never); }
  ask(apiUrl: string, budget: PaidSendBudget) {
    return this.query([{ role: 'user', content: 'Remember the supplied change.' }], {
      apiUrl, apiKey: 'owned-key', model: 'owned/model', requiresApiKey: true,
      preset: { id: 'custom', label: 'Owned test endpoint' },
    } as never, undefined, undefined, budget);
  }
}

async function withFirstReply(body: string, run: (url: string, requests: string[]) => Promise<void>) {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.text());
    return new Response(requests.length === 1 ? body : complete, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  try { await run(new URL('/v1/chat/completions', server.url).href, requests); }
  finally { await server.stop(true); }
}

for (const Provider of [Router, Compatible]) {
  for (const [ending, suffix] of [['EOF', ''], ['malformed chunk', 'data: {invalid\n\n']] as const) {
    it(`${Provider.name} does not resend generated refusal text after ${ending}`, async () => {
      const refusal = frame({ choices: [{ index: 0, delta: { refusal: 'I cannot provide that answer.' } }] });
      await withFirstReply(refusal + suffix, async (url, requests) => {
        const budget = new PaidSendBudget(1);
        const result = await new Provider().ask(url, budget).catch(error => error);
        expect(result).toBeInstanceOf(Error);
        expect(paidSendOutcomeOf(result)).toBe('output_failure');
        expect(requests).toHaveLength(1);
        expect(budget.spentPaidSends).toBe(1);
      });
    });
  }

  it(`${Provider.name} counts refusal output from an unselected choice`, async () => {
    const refusal = frame({ choices: [
      { index: 0, delta: { content: '' } },
      { index: 1, delta: { refusal: 'I cannot provide that answer.' } },
    ] });
    await withFirstReply(refusal, async (url, requests) => {
      const budget = new PaidSendBudget(1);
      const result = await new Provider().ask(url, budget).catch(error => error);
      expect(paidSendOutcomeOf(result)).toBe('output_failure');
      expect(requests).toHaveLength(1);
      expect(budget.spentPaidSends).toBe(1);
    });
  });

  it(`${Provider.name} still permits the existing resend before any refusal text`, async () => {
    const empty = frame({ choices: [{ index: 0, delta: { refusal: '' } }] });
    await withFirstReply(empty, async (url, requests) => {
      const budget = new PaidSendBudget(1);
      const result = await new Provider().ask(url, budget);
      expect(result.content).toBe(answer);
      expect(requests).toHaveLength(2);
      expect(budget.spentPaidSends).toBe(2);
    });
  });
}
