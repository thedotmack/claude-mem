import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { ApiCorpusAgent } from '../../../src/services/worker/knowledge/ApiCorpusAgent.js';
import { createCorpusAgent } from '../../../src/services/worker/knowledge/CorpusAgent.js';
import { CorpusRoutes } from '../../../src/services/worker/http/routes/CorpusRoutes.js';
import { AppError } from '../../../src/services/server/ErrorHandler.js';
import { logger } from '../../../src/utils/logger.js';
import type { CorpusStore } from '../../../src/services/worker/knowledge/CorpusStore.js';
import type { CorpusFile } from '../../../src/services/worker/knowledge/types.js';

// The corpus on the selected provider is an opt-in: the default is the Claude Agent SDK.
const OPENROUTER_SETTINGS = {
  CLAUDE_MEM_CORPUS_AGENT: 'api',
  CLAUDE_MEM_PROVIDER: 'openrouter',
  CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-test',
  CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model',
};

const CLAUDE_SETTINGS = { CLAUDE_MEM_PROVIDER: 'claude' };

interface FetchCall { url: string; headers: Record<string, string>; body: Record<string, any> }

/** Replace global fetch with a recorder that answers with the given replies in order. */
function fakeFetch(replies: Array<{ status?: number; body?: unknown; text?: string }>): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), headers: init.headers ?? {}, body: JSON.parse(String(init.body ?? '{}')) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body ?? { choices: [{ message: { content: 'the answer' } }] });
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const chatAnswer = (content: string) => ({ body: { choices: [{ message: { content } }] } });
const providerRefusal = (status: number, message: string) => ({ status, text: JSON.stringify({ error: { message } }) });

function createObservation(id: number, title: string, extra: Partial<CorpusFile['observations'][number]> = {}) {
  return {
    id,
    type: 'decision',
    title,
    subtitle: null,
    narrative: null,
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    project: 'cmem',
    created_at: '2026-04-14T00:00:00.000Z',
    created_at_epoch: 1776038400000 + id,
    ...extra,
  };
}

function createCorpus(overrides: Partial<CorpusFile> = {}): CorpusFile {
  return {
    version: 1,
    name: 'alpha',
    description: 'A corpus',
    created_at: '2026-04-14T00:00:00.000Z',
    updated_at: '2026-04-14T00:00:00.000Z',
    filter: {},
    stats: { observation_count: 3, token_estimate: 120, date_range: { earliest: '2026-04-14T00:00:00.000Z', latest: '2026-04-16T00:00:00.000Z' }, type_breakdown: { decision: 3 } },
    system_prompt: 'Answer questions using ONLY the observations provided in this corpus.',
    session_id: null,
    observations: [
      createObservation(1, 'Corpus questions run on the selected provider', {
        concepts: ['provider', 'corpus'],
        facts: ['The corpus agent follows the settings, not the code.'],
      }),
      createObservation(2, 'Observer timeout raised to thirty seconds', {
        narrative: 'The observer gave up too early on long transcripts.',
      }),
      createObservation(3, 'Search result ranking tuned', {
        facts: ['Hybrid search weighs the semantic score against the lexical one.'],
      }),
    ],
    ...overrides,
  };
}

/** A store that keeps what was written, so the test can see what a call persisted. */
function createStore(seed: CorpusFile | null = null) {
  const written: CorpusFile[] = [];
  const store = {
    write: (corpus: CorpusFile) => { written.push(corpus); },
    read: (name: string) => (written.find(entry => entry.name === name) ?? (seed?.name === name ? seed : null)),
    list: () => (seed ? [{ name: seed.name }] : []),
    delete: () => false,
  } as unknown as CorpusStore;
  return { store, written };
}

/**
 * A settings file in a temp dir, with every CLAUDE_MEM_* env var out of the
 * way (an env var would override the file and change what is under test).
 */
async function withSettings<T>(file: Record<string, string>, body: (path: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'api-corpus-'));
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_MEM_')) delete process.env[key];
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(file));
    return await body(path);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_MEM_')) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the API corpus agent answers on the selected provider', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => { restoreFetch = null; });
  afterEach(() => { restoreFetch?.(); restoreFetch = null; });

  it('primes without a model call and with a synthetic session id', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store, written } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();

      const sessionId = await agent.prime(corpus);

      expect(sessionId).toMatch(/^api:openrouter:[0-9a-f]{16}$/);
      expect(corpus.session_id).toBe(sessionId);
      expect(written.map(entry => entry.session_id)).toEqual([sessionId]);
      // Priming costs the provider nothing: there is no session to load.
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('does not prime on a provider that cannot answer, and writes nothing', async () => {
    await withSettings({ CLAUDE_MEM_CORPUS_AGENT: 'api', CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model' }, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store, written } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);

      const error = await agent.prime(createCorpus()).catch((e: unknown) => e);

      expect((error as AppError).code).toBe('PROVIDER_NOT_AUTHENTICATED');
      expect(written).toHaveLength(0);
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('does not prime for a caller that already gave up', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const { store, written } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const abortController = new AbortController();
      abortController.abort();
      const corpus = createCorpus();

      await expect(agent.prime(corpus, { abortController })).rejects.toBeDefined();

      expect(written).toHaveLength(0);
      expect(corpus.session_id).toBeNull();
    });
  });

  it('answers a question from the corpus and sends only the matching observations', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('Corpus questions run on the selected provider.')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'which provider answers corpus questions?');

      expect(result.answer).toBe('Corpus questions run on the selected provider.');
      expect(result.session_id).toBe(corpus.session_id);
      expect(result.observations_sent).toBe(1);
      expect(result.observations_matching).toBe(1);
      const prompt = String(fetchMock.calls.at(-1)!.body.messages[1].content);
      expect(prompt).toContain('Corpus questions run on the selected provider');
      expect(prompt).not.toContain('Observer timeout raised to thirty seconds');
      // The question itself reaches the provider.
      expect(prompt).toContain('which provider answers corpus questions?');
      expect(fetchMock.calls.at(-1)!.body.messages[0].content).toContain('ONLY the observations');
    });
  });

  describe('Unicode evidence selection', () => {
    const cases = [
      { name: 'decomposed question against a composed title', question: 're\u0301sume\u0301', title: 'Résumé' },
      { name: 'composed question against a decomposed title', question: 'résumé', title: 'Re\u0301sume\u0301' },
      { name: 'Hindi vowel marks in stored facts', question: 'किताब', title: 'Older source', extra: { facts: ['किताब'] } },
      { name: 'Bengali vowel marks in concepts', question: 'কিতাব', title: 'Older source', extra: { concepts: ['কিতাব'] } },
      { name: 'Hebrew points in narrative', question: 'כָּתַב', title: 'Older source', extra: { narrative: 'כָּתַב' } },
      { name: 'canonical file-path words', question: 'résumé', title: 'Older source', extra: { files_read: ['docs/re\u0301sume\u0301.md'] } },
      { name: 'canonical project words', question: 'Café', title: 'Older source', extra: { project: 'Cafe\u0301' } },
      { name: 'canonically reordered combining marks', question: 'a\u0327\u0301b', title: 'a\u0301\u0327b' },
      { name: 'canonical Unicode prefixes', question: 're\u0301su', title: 'résumé' },
      { name: 'existing decomposed Hangul syllables', question: '가', title: '가' },
      { name: 'equivalent composed Hangul syllables', question: '가', title: '가' },
      { name: 'existing decomposed Hangul prefixes', question: '가나', title: '가나다' },
      { name: 'equivalent composed Hangul prefixes', question: '가나', title: '가나다' },
      { name: 'existing ASCII prefixes', question: 'AUTH', title: 'Authentication' },
      { name: 'existing identifier and number tokens', question: 'API_v2', title: 'API_v2 update' },
    ];

    for (const testCase of cases) {
      it(`retains the matching observation for ${testCase.name}`, async () => {
        await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
          const fetchMock = fakeFetch([chatAnswer('Answer from the selected evidence.')]);
          restoreFetch = fetchMock.restore;
          const { store } = createStore();
          const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
          const corpus = createCorpus({ observations: [
            createObservation(41, testCase.title, testCase.extra),
            // If tokenization loses the match, the recency fallback spends
            // the entire excerpt budget here and drops the older source.
            createObservation(42, 'Unrelated recent note', { narrative: 'padding '.repeat(8000) }),
          ] });
          const original = JSON.stringify(corpus.observations);
          await agent.prime(corpus);

          const result = await agent.query(corpus, testCase.question);

          expect(result.observations_matching).toBe(1);
          expect(result.observations_sent).toBe(1);
          expect(result.observations_truncated).toBe(0);
          expect(fetchMock.calls).toHaveLength(1);
          const prompt = String(fetchMock.calls[0].body.messages[1].content);
          expect(prompt).toContain('(#41)');
          expect(prompt).not.toContain('(#42)');
          expect(prompt).toContain(testCase.title);
          expect(prompt).toContain(`Question: ${testCase.question}`);
          expect(JSON.stringify(corpus.observations)).toBe(original);
        });
      });
    }

    it('keeps differently accented words distinct', async () => {
      await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
        const fetchMock = fakeFetch([chatAnswer('Continue the paused operation.')]);
        restoreFetch = fetchMock.restore;
        const { store } = createStore();
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        const corpus = createCorpus({ observations: [
          createObservation(41, 'résumé'),
          createObservation(42, 'resume'),
        ] });
        await agent.prime(corpus);

        const result = await agent.query(corpus, 'resume');

        expect(result.observations_matching).toBe(1);
        const prompt = String(fetchMock.calls[0].body.messages[1].content);
        expect(prompt).toContain('(#42)');
        expect(prompt).not.toContain('(#41)');
      });
    });

    it('does not turn different vowel marks into the same word', async () => {
      await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
        const fetchMock = fakeFetch([chatAnswer('Selected the requested word.')]);
        restoreFetch = fetchMock.restore;
        const { store } = createStore();
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        const corpus = createCorpus({ observations: [
          createObservation(41, 'किताब'),
          createObservation(42, 'कातिब'),
        ] });
        await agent.prime(corpus);

        const result = await agent.query(corpus, 'किताब');

        expect(result.observations_matching).toBe(1);
        const prompt = String(fetchMock.calls[0].body.messages[1].content);
        expect(prompt).toContain('(#41)');
        expect(prompt).not.toContain('(#42)');
      });
    });
  });

  it('says so when only part of the matching observations fit the budget', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('Partial answer.')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      // 40 matching observations of about 2,500 estimated tokens each: far over the 12,000-token budget.
      const bulky = 'provider '.repeat(1100);
      const corpus = createCorpus({
        observations: Array.from({ length: 40 }, (_, index) => createObservation(index + 1, `Provider note ${index + 1}`, { narrative: bulky })),
      });
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'provider?');

      expect(result.observations_matching).toBe(40);
      expect(result.observations_sent).toBeGreaterThan(0);
      expect(result.observations_sent).toBeLessThan(40);
      const prompt = String(fetchMock.calls[0].body.messages[1].content);
      expect(prompt).toContain(`partial excerpt: ${result.observations_sent} of the 40 observations`);
    });
  });

  it('does not call the excerpt partial when every matching observation fits', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('Complete answer.')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'which provider answers corpus questions?');

      expect(String(fetchMock.calls[0].body.messages[1].content)).not.toContain('partial excerpt');
      expect(result.observations_truncated).toBe(0);
    });
  });

  it('says so when nothing matches and the most recent observations left out the rest of the corpus', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('The corpus does not hold the answer.')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const bulky = 'provider '.repeat(1100);
      const corpus = createCorpus({
        observations: Array.from({ length: 40 }, (_, index) => createObservation(index + 1, `Provider note ${index + 1}`, { narrative: bulky })),
      });
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'zebra quokka?');

      expect(result.observations_matching).toBe(0);
      expect(result.observations_in_corpus).toBe(40);
      expect(result.observations_sent).toBeGreaterThan(0);
      expect(result.observations_sent).toBeLessThan(40);
      const prompt = String(fetchMock.calls[0].body.messages[1].content);
      expect(prompt).toContain(`No observation matches the question, so this is only the ${result.observations_sent} most recent of the 40 in the corpus.`);
      expect(prompt).not.toContain('observations that match the question fit');
    });
  });

  it('does not call a whole-corpus fallback partial', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('The corpus does not hold the answer.')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'zebra quokka?');

      expect(result.observations_matching).toBe(0);
      expect(result.observations_sent).toBe(3);
      expect(result.observations_in_corpus).toBe(3);
      expect(String(fetchMock.calls[0].body.messages[1].content)).not.toContain('No observation matches');
    });
  });

  it('answers an empty corpus without a paid call', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus({ observations: [] });
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'anything?');

      expect(fetchMock.calls).toHaveLength(0);
      expect(result.answer).toContain('holds no observations');
      expect(result.observations_sent).toBe(0);
      expect(result.observations_in_corpus).toBe(0);
    });
  });

  it('cuts an observation that alone exceeds the budget and says so', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('Answer from the start of the note.')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      // About 135,000 estimated tokens in one saved note: more than ten times the 12,000-token budget.
      const corpus = createCorpus({
        observations: [createObservation(7, 'Provider note', { narrative: 'provider '.repeat(60_000) })],
      });
      await agent.prime(corpus);

      const result = await agent.query(corpus, 'provider?');

      const prompt = String(fetchMock.calls[0].body.messages[1].content);
      // The budget is 12,000 x 4 characters; the prompt carries that plus its own framing, not the whole note.
      expect(prompt.length).toBeLessThan(12_000 * 4 + 2_000);
      expect(prompt).toContain('The text of observation #7 was cut to fit');
      expect(prompt).toContain('[cut: this observation continues beyond the excerpt budget]');
      expect(result.observations_sent).toBe(1);
      expect(result.observations_matching).toBe(1);
      expect(result.observations_truncated).toBe(1);
    });
  });

  it('does not leave half of an emoji behind when it cuts', async () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // Two titles one character apart: whichever way the cut falls, one of them lands inside a pair.
    for (const title of ['a', 'ab']) {
      await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
        const fetchMock = fakeFetch([chatAnswer('ok')]);
        restoreFetch = fetchMock.restore;
        const { store } = createStore();
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        const corpus = createCorpus({
          observations: [createObservation(1, title, { narrative: '😀'.repeat(100_000) })],
        });
        await agent.prime(corpus);

        const result = await agent.query(corpus, title);

        expect(result.observations_truncated).toBe(1);
        expect(lone.test(String(fetchMock.calls[0].body.messages[1].content))).toBe(false);
      });
      restoreFetch?.();
      restoreFetch = null;
    }
  });

  it('reports a corpus that was never primed as not primed', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);

      const error = await agent.query(createCorpus(), 'anything?').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('CORPUS_NOT_PRIMED');
      // A corpus that is not primed costs the provider nothing.
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('reports a corpus primed by the Claude agent as not primed', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus({ session_id: 'a-claude-sdk-session-id' });

      const error = await agent.query(corpus, 'anything?').catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('CORPUS_NOT_PRIMED');
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('invalidates the session id when the corpus is rebuilt', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('loaded')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);
      const primedId = corpus.session_id;

      // A rebuild writes a new version of the corpus.
      const rebuilt = { ...corpus, updated_at: '2026-05-01T00:00:00.000Z' };
      const error = await agent.query(rebuilt, 'which provider answers corpus questions?').catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(409);
      expect((error as AppError).code).toBe('CORPUS_NOT_PRIMED');
      expect(primedId).toMatch(/^api:openrouter:[0-9a-f]{16}$/);
      // A stale corpus costs the provider nothing.
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('primes again on reprime, without a model call', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('loaded')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();

      const sessionId = await agent.reprime(corpus);

      expect(sessionId).toMatch(/^api:openrouter:[0-9a-f]{16}$/);
      expect(corpus.session_id).toBe(sessionId);
      expect(fetchMock.calls).toHaveLength(0);
    });
  });

  it('answers a 401 as PROVIDER_NOT_AUTHENTICATED and never asks anyone else', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([providerRefusal(401, 'invalid api key')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);
      const callsAfterPrime = fetchMock.calls.length;

      const error = await agent.query(corpus, 'which provider answers corpus questions?').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(401);
      expect((error as AppError).code).toBe('PROVIDER_NOT_AUTHENTICATED');
      // One request to the provider that refused, and no second account.
      expect(fetchMock.calls).toHaveLength(callsAfterPrime + 1);
      expect(fetchMock.calls.every(call => call.url.includes('openrouter.ai'))).toBe(true);
    });
  });

  it('answers an exhausted quota as PROVIDER_QUOTA_EXHAUSTED', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([providerRefusal(429, 'rate limited')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);

      const error = await agent.query(corpus, 'which provider answers corpus questions?').catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(429);
      expect((error as AppError).code).toBe('PROVIDER_QUOTA_EXHAUSTED');
      expect(fetchMock.calls).toHaveLength(1);
    });
  });

  it('spends nothing after a refusal: no retry, no replay, nothing persisted', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([providerRefusal(429, 'rate limited')]);
      restoreFetch = fetchMock.restore;
      const { store, written } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
      const corpus = createCorpus();
      await agent.prime(corpus);
      const primedId = corpus.session_id;

      const error = await agent.query(corpus, 'which provider answers corpus questions?').catch((e: unknown) => e);
      expect((error as AppError).code).toBe('PROVIDER_QUOTA_EXHAUSTED');
      const callsAfterFailure = fetchMock.calls.length;

      // An outage must not create later, unrequested inference spend: nothing
      // runs on its own after the refusal.
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(fetchMock.calls).toHaveLength(callsAfterFailure);
      // The failed query persisted nothing: the corpus is still the primed one.
      expect(written).toHaveLength(1);
      expect(corpus.session_id).toBe(primedId);
    });
  });

  it('fails with PROVIDER_NOT_AUTHENTICATED when the provider has no key', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model' }, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      restoreFetch = fetchMock.restore;
      const { store } = createStore();
      const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);

      const error = await agent.prime(createCorpus()).catch((e: unknown) => e);

      expect((error as AppError).statusCode).toBe(401);
      expect((error as AppError).code).toBe('PROVIDER_NOT_AUTHENTICATED');
      expect(fetchMock.calls).toHaveLength(0);
    });
  });
});

describe('CorpusRoutes with the API corpus agent', () => {
  class FakeResponse extends EventEmitter {
    statusCode = 200;
    jsonBodies: unknown[] = [];
    headersSent = false;
    ended = false;
    status(code: number) { this.statusCode = code; return this; }
    setHeader() {}
    write() { this.headersSent = true; return true; }
    json(body: unknown) { this.headersSent = true; this.jsonBodies.push(body); this.ended = true; return this; }
    end() { this.ended = true; return this; }
  }

  function createRequest(name: string, body: any = {}) {
    return {
      body,
      params: { name },
      path: `/api/corpus/${name}/query`,
      query: {},
      headers: {},
      socket: new EventEmitter(),
    } as unknown as Request;
  }

  function captureHandler(routes: CorpusRoutes, targetPath: string): (req: Request, res: Response) => void {
    let handler: ((req: Request, res: Response) => void) | undefined;
    const mockApp: any = {
      get: mock(() => {}),
      delete: mock(() => {}),
      post: mock((path: string, ...rest: any[]) => {
        if (path === targetPath) handler = rest[rest.length - 1];
      }),
    };
    routes.setupRoutes(mockApp);
    if (!handler) throw new Error(`${targetPath} not registered`);
    return handler;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();
    while (!condition()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  it('answers 409 CORPUS_NOT_PRIMED for a corpus that was never primed', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      try {
        const corpus = createCorpus();
        const { store } = createStore(corpus);
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        const routes = new CorpusRoutes(store, { build: mock(() => Promise.resolve(corpus)) } as any, agent);
        const handler = captureHandler(routes, '/api/corpus/:name/query');
        const res = new FakeResponse();

        handler(createRequest('alpha', { question: 'why?' }), res as unknown as Response);
        await waitFor(() => res.ended);

        expect(res.statusCode).toBe(409);
        expect(res.jsonBodies).toEqual([{ error: 'Corpus "alpha" has no session — call prime first', code: 'CORPUS_NOT_PRIMED' }]);
        expect(fetchMock.calls).toHaveLength(0);
      } finally {
        fetchMock.restore();
      }
    });
  });

  it('forwards how much of the corpus the answer saw', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('Corpus questions run on the selected provider.')]);
      try {
        const corpus = createCorpus();
        const { store } = createStore(corpus);
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        await agent.prime(corpus);
        const routes = new CorpusRoutes(store, { build: mock(() => Promise.resolve(corpus)) } as any, agent);
        const handler = captureHandler(routes, '/api/corpus/:name/query');
        const res = new FakeResponse();

        handler(createRequest('alpha', { question: 'which provider answers corpus questions?' }), res as unknown as Response);
        await waitFor(() => res.ended);

        expect(res.statusCode).toBe(200);
        expect(res.jsonBodies[0]).toMatchObject({
          answer: 'Corpus questions run on the selected provider.',
          observations_sent: 1,
          observations_matching: 1,
          observations_in_corpus: 3,
          observations_truncated: 0,
        });
      } finally {
        fetchMock.restore();
      }
    });
  });

  it('answers 401 PROVIDER_NOT_AUTHENTICATED when the provider refuses', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([providerRefusal(401, 'invalid api key')]);
      const errorSink = mock(() => {});
      logger.setErrorSink(errorSink);
      try {
        const corpus = createCorpus();
        const { store } = createStore(corpus);
        const agent = new ApiCorpusAgent(store, 'openrouter', settingsPath);
        await agent.prime(corpus);
        const routes = new CorpusRoutes(store, { build: mock(() => Promise.resolve(corpus)) } as any, agent);
        const handler = captureHandler(routes, '/api/corpus/:name/query');
        const res = new FakeResponse();

        handler(createRequest('alpha', { question: 'why?' }), res as unknown as Response);
        await waitFor(() => res.ended);

        expect(res.statusCode).toBe(401);
        expect((res.jsonBodies[0] as { code?: string }).code).toBe('PROVIDER_NOT_AUTHENTICATED');
        // A provider that refuses is the owner's problem, not a server fault.
        expect(errorSink).not.toHaveBeenCalled();
        expect(fetchMock.calls).toHaveLength(1);
      } finally {
        logger.setErrorSink(null);
        fetchMock.restore();
      }
    });
  });
});

describe('the Anthropic SDK is not loaded on the API provider path', () => {
  const fixture = String.raw`
    import { mock } from 'bun:test';
    const sdkLoads = [];
    // The Anthropic SDK module is replaced by a recorder: if anything imports
    // it, the recorder knows, and the real SDK never runs.
    mock.module('@anthropic-ai/claude-agent-sdk', () => {
      sdkLoads.push('anthropic-sdk');
      return { query: () => { throw new Error('the Anthropic SDK must not run in this test'); } };
    });
    const { createCorpusAgent } = await import('./src/services/worker/knowledge/CorpusAgent.ts');
    const store = { write: () => {}, read: () => null };
    const apiAgent = await createCorpusAgent(store, process.env.API_SETTINGS);
    const apiName = (await apiAgent.current()).constructor.name;
    const afterApi = sdkLoads.length;
    const claudeAgent = await createCorpusAgent(store, process.env.CLAUDE_SETTINGS);
    const claudeName = (await claudeAgent.current()).constructor.name;
    console.log(JSON.stringify({
      afterApi,
      afterClaude: sdkLoads.length,
      apiAgent: apiName,
      claudeAgent: claudeName,
    }));
  `;

  it('loads the Claude agent only when the corpus agent is not set to api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-corpus-sdk-'));
    try {
      const apiSettings = join(dir, 'api.json');
      const claudeSettings = join(dir, 'claude.json');
      writeFileSync(apiSettings, JSON.stringify(OPENROUTER_SETTINGS));
      writeFileSync(claudeSettings, JSON.stringify(CLAUDE_SETTINGS));
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, API_SETTINGS: apiSettings, CLAUDE_SETTINGS: claudeSettings },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const outcome = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);

      // The API provider: the Anthropic SDK module was never loaded.
      expect(outcome.afterApi).toBe(0);
      expect(outcome.apiAgent).toBe('ApiCorpusAgent');
      // The Claude provider: the dynamic import loaded it (and with it the SDK).
      expect(outcome.afterClaude).toBe(1);
      expect(outcome.claudeAgent).toBe('KnowledgeAgent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the corpus agent factory follows CLAUDE_MEM_CORPUS_AGENT', () => {
  const OPENAI_COMPAT = { CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://llm.test/v1', CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'local/model' };

  it('returns the Claude agent on openrouter when the setting is empty (the default)', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-test', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model' }, async (settingsPath) => {
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('KnowledgeAgent');
    });
  });

  it('returns the Claude agent on openai-compatible and cmem when the setting is empty', async () => {
    for (const settings of [OPENAI_COMPAT, { CLAUDE_MEM_PROVIDER: 'cmem' }]) {
      await withSettings(settings, async (settingsPath) => {
        const { store } = createStore();
        const agent = await createCorpusAgent(store, settingsPath);
        expect((await agent.current()).constructor.name).toBe('KnowledgeAgent');
      });
    }
  });

  it('refuses a corpus primed by the API agent once the setting is emptied, without calling the Claude SDK', async () => {
    await withSettings(OPENROUTER_SETTINGS, async (settingsPath) => {
      const fetchMock = fakeFetch([chatAnswer('never used')]);
      try {
        const { store } = createStore();
        const agent = await createCorpusAgent(store, settingsPath);
        const corpus = createCorpus();
        corpus.session_id = await agent.prime(corpus);
        expect(corpus.session_id.startsWith('api:')).toBe(true);

        // The owner opts out: the next query would go to the Claude agent.
        writeFileSync(settingsPath, JSON.stringify({ ...OPENROUTER_SETTINGS, CLAUDE_MEM_CORPUS_AGENT: '' }));
        const error = await agent.query(corpus, 'which provider answers corpus questions?').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(409);
        expect((error as AppError).code).toBe('CORPUS_NOT_PRIMED');
        expect(fetchMock.calls).toHaveLength(0);
      } finally {
        fetchMock.restore();
      }
    });
  });

  it('does not fall through to Claude on a value it does not know, and reads api in any case', async () => {
    for (const unknown of ['openrouter', 'claude', 'apii', 'on']) {
      await withSettings({ ...OPENROUTER_SETTINGS, CLAUDE_MEM_CORPUS_AGENT: unknown }, async (settingsPath) => {
        const { store } = createStore();
        const agent = await createCorpusAgent(store, settingsPath);
        for (const call of [() => agent.prime(createCorpus()), () => agent.query(createCorpus(), 'q?'), () => agent.reprime(createCorpus())]) {
          const error = await call().catch((e: unknown) => e);
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).statusCode).toBe(400);
          expect((error as AppError).code).toBe('CORPUS_AGENT_UNAVAILABLE');
        }
      });
    }
    for (const spelled of ['API', ' Api ']) {
      await withSettings({ ...OPENROUTER_SETTINGS, CLAUDE_MEM_CORPUS_AGENT: spelled }, async (settingsPath) => {
        const { store } = createStore();
        const agent = await createCorpusAgent(store, settingsPath);
        expect((await agent.current()).constructor.name).toBe('ApiCorpusAgent');
      });
    }
  });

  it('returns the API agent for an OpenAI-compatible provider when set to api', async () => {
    await withSettings({ ...OPENAI_COMPAT, CLAUDE_MEM_CORPUS_AGENT: 'api' }, async (settingsPath) => {
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('ApiCorpusAgent');
    });
  });

  it('returns the API agent for the legacy cmem spelling when set to api', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'cmem', CLAUDE_MEM_CORPUS_AGENT: 'api' }, async (settingsPath) => {
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('ApiCorpusAgent');
    });
  });

  it('fails clearly, and does not fall back to Claude, when api is set on a provider that is not an API endpoint', async () => {
    for (const provider of ['claude', 'codex', 'gemini']) {
      await withSettings({ CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_CORPUS_AGENT: 'api' }, async (settingsPath) => {
        const fetchMock = fakeFetch([chatAnswer('never used')]);
        try {
          const { store, written } = createStore();
          const agent = await createCorpusAgent(store, settingsPath);
          const corpus = createCorpus();

          for (const call of [
            () => agent.prime(corpus),
            () => agent.query(corpus, 'anything?'),
            () => agent.reprime(corpus),
          ]) {
            const error = await call().catch((e: unknown) => e);
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).statusCode).toBe(400);
            expect((error as AppError).code).toBe('CORPUS_AGENT_UNAVAILABLE');
          }
          expect(written).toHaveLength(0);
          expect(fetchMock.calls).toHaveLength(0);
        } finally {
          fetchMock.restore();
        }
      });
    }
  });
});

describe('the corpus agent follows a setting change without a restart', () => {
  it('answers on the API provider once the setting is api, and on Claude again once it is emptied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-corpus-switch-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      const base = { CLAUDE_MEM_PROVIDER: 'openrouter' };
      writeFileSync(settingsPath, JSON.stringify(base));
      const { store } = createStore();
      const agent = await createCorpusAgent(store, settingsPath);
      expect((await agent.current()).constructor.name).toBe('KnowledgeAgent');
      writeFileSync(settingsPath, JSON.stringify({ ...base, CLAUDE_MEM_CORPUS_AGENT: 'api' }));
      expect((await agent.current()).constructor.name).toBe('ApiCorpusAgent');
      // No key is configured, so the call fails on the provider's own error and never reaches the Claude agent.
      await expect(agent.query({ name: 'c', session_id: null, observations: [] } as never, 'q')).rejects.toMatchObject({ code: 'CORPUS_NOT_PRIMED' });
      writeFileSync(settingsPath, JSON.stringify(base));
      expect((await agent.current()).constructor.name).toBe('KnowledgeAgent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
