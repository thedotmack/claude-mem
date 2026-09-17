import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';

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
let runtimeStub: unknown = { runtime: 'worker' };
let impl: (i: Record<string, unknown>) => Promise<unknown> = async () => ({ observations: [] });

mock.module('../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => runtimeStub,
}));

const { fetchServerObservations, toLocalObservationShape } =
  await import('../../src/services/context/ContextBuilder.js');

const serverRuntime = () => ({
  runtime: 'server',
  projectId: 'demo-project',
  serverBaseUrl: 'http://memory.example:37878',
  client: {
    contextObservations: async (i: Record<string, unknown>) => { contextCalls.push(i); return impl(i); },
  },
});

const cfg = (n: number) => ({ totalObservationCount: n } as never);

afterEach(() => {
  contextCalls = [];
  runtimeStub = { runtime: 'worker' };
  impl = async () => ({ observations: [] });
});

// bun re-points a mocked module for the WHOLE run, so leaving this stub in place
// fails tests/hooks/runtime-selector.test.ts in any file that happens to run after
// this one -- measured: 4 failures, none of them in this file. The namespace is
// snapshotted eagerly above, before the mock, for the same reason.
afterAll(() => {
  mock.module('../../src/services/hooks/runtime-selector.js', () => realSnapshot);
});

describe('the shared store as a row source', () => {
  it('returns rows in server runtime', async () => {
    runtimeStub = serverRuntime();
    impl = async () => ({ observations: [{ id: 'x', content: 'Fixed the read path', kind: 'bugfix', createdAtEpoch: 1_760_000_000_000 }] });
    const rows = await fetchServerObservations(cfg(20), 'p', undefined);
    expect(rows).not.toBeNull();
    expect(rows!).toHaveLength(1);
    expect(rows![0].title).toBe('Fixed the read path');
  });

  it('omits `query` ENTIRELY -- the key is what selects recency over relevance', async () => {
    runtimeStub = serverRuntime();
    impl = async () => ({ observations: [{ id: 'x', content: 'c', createdAtEpoch: 1 }] });
    await fetchServerObservations(cfg(20), 'p', undefined);
    // Not `query: ''` -- the route rejects an empty string (min 1 char) and ranks
    // by FTS when one is present. Absent is the only thing that means "newest".
    expect(Object.prototype.hasOwnProperty.call(contextCalls[0], 'query')).toBe(false);
  });

  it('clamps the limit to what the route accepts', async () => {
    runtimeStub = serverRuntime();
    impl = async () => ({ observations: [{ id: 'x', content: 'c', createdAtEpoch: 1 }] });
    await fetchServerObservations(cfg(500), 'p', undefined);
    // The route REFUSES above 50: unclamped this does not degrade, it fails empty.
    expect(contextCalls[0].limit).toBe(50);
  });

  it('falls back to null when the store throws', async () => {
    runtimeStub = serverRuntime();
    impl = async () => { throw new Error('ECONNREFUSED'); };
    expect(await fetchServerObservations(cfg(20), 'p', undefined)).toBeNull();
  });

  it('falls back to null on an empty answer rather than rendering an empty memory', async () => {
    runtimeStub = serverRuntime();
    impl = async () => ({});
    expect(await fetchServerObservations(cfg(20), 'p', undefined)).toBeNull();
  });

  it('never consults the store in worker runtime', async () => {
    runtimeStub = { runtime: 'worker' };
    expect(await fetchServerObservations(cfg(20), 'p', undefined)).toBeNull();
    expect(contextCalls).toHaveLength(0);
  });
});

describe('the row shape the renderer is handed', () => {
  it('carries `kind` into `type`, not the literal "observation"', () => {
    // `type` drives the emoji and the type histogram. Defaulting it would render
    // every memory as the same kind and quietly flatten the legend.
    const r = toLocalObservationShape({ id: 'a', kind: 'bugfix', content: 'x', createdAtEpoch: 1 }, 0, 'p', undefined);
    expect(r.type).toBe('bugfix');
  });

  it('stringifies the JSON columns, because the local schema stores strings', () => {
    // The writer calls JSON.stringify on each of these. Handing the renderer raw
    // arrays changes what the token counter measures and skews the savings stats.
    const r = toLocalObservationShape(
      { id: 'a', content: 'x', createdAtEpoch: 1, metadata: { facts: ['one', 'two'], concepts: ['c'] } },
      0, 'p', undefined,
    );
    expect(typeof r.facts).toBe('string');
    expect(JSON.parse(r.facts as string)).toEqual(['one', 'two']);
    expect(typeof r.concepts).toBe('string');
  });

  it('titles a row from its first line when the store carries no title', () => {
    const r = toLocalObservationShape({ id: 'a', content: 'First line\nrest of it', createdAtEpoch: 1 }, 0, 'p', undefined);
    expect(r.title).toBe('First line');
  });
});
