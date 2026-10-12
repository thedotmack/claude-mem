import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';

import * as realRuntimeSelector from '../../src/services/hooks/runtime-selector.js';

/**
 * In `server` runtime the session-start block must be built from the SHARED store.
 *
 * MEASURED 2026-09-17: the local corpus took 1 observation in 24h while the store
 * took 18,184. Nothing errored -- the client has shipped contextObservations() ->
 * POST /v1/context all along and nothing called it, so a session simply opened onto
 * a corpus frozen where server mode began.
 *
 * THE FIX REPLACES THE ROW SOURCE, NOT THE OUTPUT, and these tests pin that choice.
 * The first attempt injected the route's pre-joined `context` string straight into
 * the hook result: it bypassed fitContextToBudget and came back at 52,337 characters
 * against a CONTEXT_OUTPUT_LIMIT of 10,000, losing the header, the ids and the stats
 * -- 13,084 tokens where the local block spent 1,787. Returning ROWS keeps the
 * renderer, the budget fitter and the token counter exactly as they were.
 */

const realSnapshot = { ...realRuntimeSelector };

let contextCalls: Array<Record<string, unknown>> = [];
let contextCallOptions: Array<Record<string, unknown> | undefined> = [];
let runtimeStub: unknown = { runtime: 'worker' };
let respond: (request: Record<string, unknown>) => Promise<unknown> = async () => ({ observations: [] });

mock.module('../../src/services/hooks/runtime-selector.js', () => ({
  ...realSnapshot,
  resolveRuntimeContext: () => runtimeStub,
}));

const { fetchServerContextRows, toLocalObservationShape, toLocalSummaryShape } =
  await import('../../src/services/context/ServerContextRows.js');
const { generateContextWithStats, generateServerContextWithStats, generateServerSessionStartContext } =
  await import('../../src/services/context/ContextBuilder.js');
const { CONTEXT_OUTPUT_LIMIT } = await import('../../src/services/context/ContextBudget.js');
const { ModeManager } = await import('../../src/services/domain/ModeManager.js');

const serverRuntime = () => ({
  runtime: 'server' as const,
  projectId: 'demo-project',
  serverBaseUrl: 'http://memory.example:37878',
  client: {
    contextObservations: async (request: Record<string, unknown>, options?: Record<string, unknown>) => {
      contextCalls.push(request);
      contextCallOptions.push(options);
      return respond(request);
    },
  },
}) as never;

const config = (totalObservationCount: number, sessionCount = 10) =>
  ({ totalObservationCount, sessionCount } as never);

const rowsRequest = (overrides: Record<string, unknown> = {}) => ({
  config: config(20),
  project: 'demo',
  folderProjects: ['demo'],
  platformSource: undefined,
  ...overrides,
}) as never;

function observationRow(index: number, extra: Record<string, unknown> = {}) {
  return {
    id: `0000000${index}-5048-45fa-95e0-e3222ae99671`,
    projectId: 'demo-project',
    serverSessionId: 'server-session-1',
    kind: 'bugfix',
    content: `Observation ${index} body`,
    metadata: { title: `Observation ${index}`, narrative: 'n'.repeat(400), project: 'demo' },
    createdAtEpoch: 1_760_000_000_000 - index * 60_000,
    ...extra,
  };
}

beforeAll(() => {
  ModeManager.getInstance().loadMode('code');
});

afterEach(() => {
  contextCalls = [];
  contextCallOptions = [];
  runtimeStub = { runtime: 'worker' };
  respond = async () => ({ observations: [] });
});

// bun re-points a mocked module for the WHOLE run, so leaving this stub in place
// fails tests/hooks/runtime-selector.test.ts in any file that happens to run after
// this one -- measured: 4 failures, none of them in this file. The namespace is
// snapshotted eagerly above, before the mock, for the same reason.
afterAll(() => {
  mock.module('../../src/services/hooks/runtime-selector.js', () => realSnapshot);
});

describe('the shared store as a row source', () => {
  it('splits server rows into observations and summaries', async () => {
    respond = async () => ({
      observations: [
        observationRow(1),
        { id: 's1', kind: 'summary', content: 'x', metadata: { request: 'Fix the read path' }, createdAtEpoch: 2 },
      ],
    });
    const rows = await fetchServerContextRows(serverRuntime(), rowsRequest());
    expect(rows!.observations.map(o => o.title)).toEqual(['Observation 1']);
    expect(rows!.summaries.map(s => s.request)).toEqual(['Fix the read path']);
  });

  it('omits `query` ENTIRELY -- the key is what selects recency over relevance', async () => {
    await fetchServerContextRows(serverRuntime(), rowsRequest());
    // Not `query: ''` -- the route rejects an empty string (min 1 char) and ranks
    // by FTS when one is present. Absent is the only thing that means "newest".
    expect(Object.prototype.hasOwnProperty.call(contextCalls[0], 'query')).toBe(false);
  });

  it('asks for the observation and summary counts, clamped to what the route accepts', async () => {
    await fetchServerContextRows(serverRuntime(), rowsRequest({ config: config(20, 10) }));
    expect(contextCalls[0].limit).toBe(31);
    await fetchServerContextRows(serverRuntime(), rowsRequest({ config: config(999999, 999999) }));
    // The route REFUSES above 200: unclamped this does not degrade, it fails empty.
    expect(contextCalls[1].limit).toBe(200);
  });

  it('scopes the read to this folder and platform', async () => {
    await fetchServerContextRows(serverRuntime(), rowsRequest({
      folderProjects: ['parent', 'demo'],
      platformSource: 'claude',
    }));
    expect(contextCalls[0].folderProjects).toEqual(['parent', 'demo']);
    expect(contextCalls[0].platformSource).toBe('claude');
  });

  it('asks the store to leave subagent rows out exactly when CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY is on', async () => {
    await fetchServerContextRows(serverRuntime(), rowsRequest({
      config: { totalObservationCount: 20, sessionCount: 10, mainAgentOnly: true },
    }));
    await fetchServerContextRows(serverRuntime(), rowsRequest({
      config: { totalObservationCount: 20, sessionCount: 10, mainAgentOnly: false },
    }));
    expect(contextCalls.map(call => call.excludeSubagents)).toEqual([true, false]);
  });

  it('bounds the request by the caller\'s timeout, and leaves the client default alone without one', async () => {
    await fetchServerContextRows(serverRuntime(), rowsRequest({ timeoutMs: 15_000 }));
    await fetchServerContextRows(serverRuntime(), rowsRequest());
    expect(contextCallOptions).toEqual([{ timeoutMs: 15_000 }, {}]);
  });

  it('returns null when the store cannot answer', async () => {
    respond = async () => { throw new Error('ECONNREFUSED'); };
    expect(await fetchServerContextRows(serverRuntime(), rowsRequest())).toBeNull();
  });

  it('treats an empty answer as authoritative, not as a reason to fall back', async () => {
    respond = async () => ({ observations: [] });
    expect(await fetchServerContextRows(serverRuntime(), rowsRequest()))
      .toEqual({ observations: [], summaries: [] });
  });
});

describe('the row shape the renderer is handed', () => {
  it('carries `kind` into `type`, not the literal "observation", and keeps the server id', () => {
    // `type` drives the emoji and the type histogram. Defaulting it would render
    // every memory as the same kind and quietly flatten the legend.
    const row = toLocalObservationShape({ id: 'a1', kind: 'bugfix', content: 'x', createdAtEpoch: 1 }, 'p', undefined);
    expect(row.type).toBe('bugfix');
    expect(row.id).toBe('a1');
  });

  it('stringifies the JSON columns, because the local schema stores strings', () => {
    // The writer calls JSON.stringify on each of these. Handing the renderer raw
    // arrays changes what the token counter measures and skews the savings stats.
    const row = toLocalObservationShape(
      { id: 'a', content: 'x', createdAtEpoch: 1, metadata: { facts: ['one', 'two'], concepts: ['c'] } },
      'p', undefined,
    );
    expect(typeof row.facts).toBe('string');
    expect(JSON.parse(row.facts as string)).toEqual(['one', 'two']);
    expect(typeof row.concepts).toBe('string');
  });

  it('titles a row from its first line when the store carries no title', () => {
    const row = toLocalObservationShape({ id: 'a', content: 'First line\nrest of it', createdAtEpoch: 1 }, 'p', undefined);
    expect(row.title).toBe('First line');
  });

  it('maps a kind=summary row into the session summary shape', () => {
    const summary = toLocalSummaryShape({
      id: 's1',
      kind: 'summary',
      serverSessionId: 'server-session-1',
      content: 'rendered summary',
      metadata: { request: 'r', investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', project: 'demo' },
      createdAtEpoch: 5,
    }, 'fallback', 'claude');
    expect(summary).toMatchObject({
      id: 's1',
      memory_session_id: 'server-session-1',
      request: 'r',
      investigated: 'i',
      learned: 'l',
      completed: 'c',
      next_steps: 'n',
      project: 'demo',
      created_at_epoch: 5,
    });
  });
});

describe('session-start context from the shared store', () => {
  const input = { projects: ['demo'], cwd: process.cwd() };

  it('renders server rows through the budget fitter', async () => {
    respond = async () => ({ observations: Array.from({ length: 200 }, (_, index) => observationRow(index)) });
    const { text, stats } = await generateServerContextWithStats(serverRuntime(), input);
    expect(text.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(text).toContain('# [demo] recent context');
    expect(text).toContain('Observation 0');
    expect(stats!.observation_count).toBeGreaterThan(0);
  });

  it('prints 8-char display refs and points at observation_search, since server ids have no by-id fetch', async () => {
    respond = async () => ({
      observations: [
        observationRow(3),
        {
          ...observationRow(4),
          id: 'abcdef12-5048-45fa-95e0-e3222ae99671',
          kind: 'summary',
          metadata: { request: 'Ship the import fix', project: 'demo' },
        },
      ],
    });
    const { text } = await generateServerContextWithStats(serverRuntime(), input);
    expect(text).toContain('00000003 ');
    expect(text).not.toContain('00000003-5048');
    expect(text).toContain('Sabcdef12 Ship the import fix');
    expect(text).not.toContain('abcdef12-5048');
    expect(text).toContain('observation_search');
    expect(text).not.toContain('get_observations');
  });

  it('renders the empty state for an empty answer', async () => {
    respond = async () => ({ observations: [] });
    const { text, stats } = await generateServerContextWithStats(serverRuntime(), input);
    expect(text).toContain('No previous sessions found.');
    expect(stats).toBeNull();
  });

  it('renders nothing, rather than stale local rows, when the store cannot answer', async () => {
    respond = async () => { throw new Error('ECONNREFUSED'); };
    const { text, stats } = await generateServerContextWithStats(serverRuntime(), input);
    expect(text).toBe('');
    expect(stats).toBeNull();
  });

  it('is what generateContextWithStats serves in server runtime, with no local database opened', async () => {
    runtimeStub = serverRuntime();
    respond = async () => ({ observations: [observationRow(7)] });
    const { text } = await generateContextWithStats(input);
    expect(contextCalls).toHaveLength(1);
    expect(text).toContain('Observation 7');
  });

  it('reads the store ONCE for a SessionStart that also renders the colored terminal copy (#3227 read twice)', async () => {
    respond = async () => ({ observations: [observationRow(1), observationRow(2)] });
    const { model, terminal } = await generateServerSessionStartContext(serverRuntime(), input, {
      withTerminalRender: true,
      timeoutMs: 12_000,
    });
    expect(contextCalls).toHaveLength(1);
    expect(contextCallOptions).toEqual([{ timeoutMs: 12_000 }]);
    expect(model).toContain('Observation 1');
    expect(terminal).toContain('Observation 1');
    // The terminal copy is its own (colored) rendering of the same rows.
    expect(terminal).not.toBe(model);
  });

  it('renders only the model block when no terminal copy is wanted', async () => {
    respond = async () => ({ observations: [observationRow(1)] });
    const { model, terminal } = await generateServerSessionStartContext(serverRuntime(), input, {
      withTerminalRender: false,
      timeoutMs: 12_000,
    });
    expect(contextCalls).toHaveLength(1);
    expect(model).toContain('Observation 1');
    expect(terminal).toBeNull();
  });

  it('never consults the store in worker runtime', async () => {
    runtimeStub = { runtime: 'worker' };
    await generateContextWithStats(input);
    expect(contextCalls).toHaveLength(0);
  });
});
