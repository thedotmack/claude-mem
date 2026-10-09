import assert from 'node:assert/strict';
import { MemoryProgressiveCursorStore, renderMemoryContent, projectMemoryContent, progressiveSearchToolResult, progressiveSearchToolError, type ProgressiveSearch, type ProgressiveContinuationState, ProgressiveBackend, ProgressiveSearchInput, ProgressiveSearchResult, MemoryIndexRow } from '../../src/shared/progressive-search.js';

type Engine = typeof ProgressiveSearch;
const secret = 'progressive-search-fixture-key-32-bytes';
const row = (id: string, title = 'Authentication fix', project = 'fixture', kind: MemoryIndexRow['kind'] = 'observation'): MemoryIndexRow => ({ id, title, project, kind, createdAt: 1000, type: 'decision' });
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function fixture(Implementation: Engine, overrides: Partial<ProgressiveBackend> = {}) {
  const calls: { operation: string; ids?: string[]; query?: string }[] = [];
  let time = 1000;
  const backend: ProgressiveBackend = {
    search: async (input) => { calls.push({ operation: 'search', query: input.query }); return [{ ...row('1'), narrative: 'NEVER_IN_INDEX' }, row('2', 'Unrelated gardening'), row('P3', 'Authentication prompt', 'fixture', 'prompt')]; },
    timeline: async ({ anchor }) => { calls.push({ operation: 'timeline', ids: [anchor.id] }); return [anchor, row('4', 'Authentication correction'), row('P5', 'Authentication prompt', 'fixture', 'prompt'), row('foreign', 'Authentication foreign', 'foreign')]; },
    fetch: async (refs) => { calls.push({ operation: 'fetch', ids: refs.map(ref => ref.id) }); return [...refs.map(ref => ({ ...ref, content: `DETAIL_${ref.id}`, truncated: false })), { ...row('injected'), content: 'NEVER_UNSELECTED', truncated: false }]; },
    ...overrides,
  };
  let cursorId = 0;
  const backingStore = new MemoryProgressiveCursorStore({ now: () => time });
  const states: ProgressiveContinuationState[] = [];
  const cursorStore = {
    async put(key: string, state: ProgressiveContinuationState) { states.push(structuredClone(state)); await backingStore.put(key, state); },
    async get(key: string, scope: string) { return backingStore.get(key, scope); },
  };
  const newCursor = () => `ms_${String(++cursorId).padStart(24, '0')}`;
  const engine = new Implementation(backend, { secret, scope: 'fixture-scope', cursorStore, newCursor, now: () => time });
  return { engine, backend, calls, cursorStore, states, newCursor, expire: () => { time += 15 * 60 * 1000 + 1; } };
}

/** Shared adversarial cases used by cloud and worker; no live memory or network. */
export async function runProgressiveSearchCases(Implementation: Engine): Promise<{ count: number; guided: ProgressiveSearchResult[]; auto: ProgressiveSearchResult | undefined }> {
  let count = 0;
  const check = async (body: () => void | Promise<void>) => { await body(); count++; };
  let guided: ProgressiveSearchResult[] = [];
  let auto: ProgressiveSearchResult | undefined;
  await check(async () => {
    const f = fixture(Implementation);
    const one = await f.engine.run({ query: 'authentication', project: 'fixture' });
    assert.equal(one.label, 'mem-search step 1 of 3');
    assert.equal(one.observations.length, 0);
    assert(!JSON.stringify(one).includes('NEVER_IN_INDEX'));
    assert.equal(one.next.instruction.includes('step 2 of 3'), true);
    const two = await f.engine.run({ continuation: one.continuation, selectedIds: [1] });
    assert.equal(two.label, 'mem-search step 2 of 3');
    assert(two.index.every((item) => item.project === 'fixture'));
    assert(!f.calls.some(item => item.operation === 'fetch'));
    const three = await f.engine.run({ continuation: two.continuation, selectedIds: ['4'] });
    assert.equal(three.label, 'mem-search step 3 of 3');
    assert.deepEqual(three.observations.map((item) => item.id), ['4']);
    assert.deepEqual(f.calls.filter(item => item.operation === 'fetch').map(item => item.ids), [['4']]);
    assert(!JSON.stringify(three).includes('NEVER_UNSELECTED'));
    guided = [one, two, three];
  });
  await check(async () => {
    const f = fixture(Implementation);
    auto = await f.engine.run({ query: 'authentication', project: 'fixture', mode: 'auto', maxDetails: 2 });
    assert.equal(auto.step, 3);
    assert.deepEqual(auto.trace.map((item) => item.operation), ['search', 'timeline', 'fetch']);
    assert(auto.observations.length <= 2);
    assert.deepEqual(f.calls.filter(item => item.operation === 'fetch').map(item => item.ids), [['1', '4']]);
  });
  await check(async () => {
    const f = fixture(Implementation); const one = await f.engine.run({ query: 'authentication' }); f.expire();
    await assert.rejects(f.engine.run({ continuation: one.continuation, selectedIds: ['1'] }), /expired/);
  });
  await check(async () => {
    const f = fixture(Implementation); const one = await f.engine.run({ query: 'authentication' });
    const altered = (one.continuation[0] === 'A' ? 'B' : 'A') + one.continuation.slice(1);
    await assert.rejects(f.engine.run({ continuation: altered, selectedIds: ['1'] }), /Invalid mem-search continuation/);
    await assert.rejects(f.engine.run({ continuation: 'x'.repeat(50_000), selectedIds: ['1'] }), /Invalid mem-search continuation/);
  });
  await check(async () => {
    const f = fixture(Implementation); const one = await f.engine.run({ query: 'authentication' });
    const other = new Implementation(f.backend, { secret, scope: 'other-scope', cursorStore: f.cursorStore, newCursor: f.newCursor, now: () => 1000 });
    await assert.rejects(other.run({ continuation: one.continuation, selectedIds: ['1'] }), /different memory scope/);
  });
  for (const [key, changed] of Object.entries({ query: 'other', project: 'other', limit: 1, maxDetails: 1, depthBefore: 0, depthAfter: 0 })) {
    await check(async () => {
      const f = fixture(Implementation); const one = await f.engine.run({ query: 'authentication', project: 'fixture' });
      await assert.rejects(f.engine.run({ continuation: one.continuation, selectedIds: ['1'], [key]: changed }), /original search options/);
    });
  }
  await check(async () => {
    const f = fixture(Implementation); const one = await f.engine.run({ query: 'authentication' });
    await assert.rejects(f.engine.run({ continuation: one.continuation, selectedIds: ['random-unseen-id'] }), /not disclosed/);
    await assert.rejects(f.engine.run({ continuation: one.continuation, selectedIds: [Number.MAX_SAFE_INTEGER + 1] }), /safe integer/);
    await assert.rejects(f.engine.run({ query: 'authentication', selectedIds: ['1'] }), /preceding step/);
  });
  for (const input of [
    { query: '' }, { query: 'x'.repeat(501) }, { query: '😀'.repeat(300) },
    { query: 'authentication', limit: 0 }, { query: 'authentication', limit: 21 },
    { query: 'authentication', limit: 1.5 }, { query: 'authentication', maxDetails: 6 },
    { query: 'authentication', depthBefore: -1 }, { query: 'authentication', depthAfter: 4 },
    { query: 'authentication', mode: 'unsupported' },
  ]) await check(async () => { await assert.rejects(fixture(Implementation).engine.run(input as ProgressiveSearchInput)); });
  await check(async () => {
    const f = fixture(Implementation); const one = await f.engine.run({ query: 'authentication' });
    const two = await f.engine.run({ continuation: one.continuation, selectedIds: ['P3'] });
    await assert.rejects(f.engine.run({ continuation: two.continuation, selectedIds: ['P5'] }), /Prompts supply timeline context/);
    assert(!f.calls.some(item => item.operation === 'fetch'));
  });
  await check(async () => {
    const f = fixture(Implementation, { search: async () => [row('semantic', 'Credentials rotation')] });
    const response = await f.engine.run({ query: 'authentication', mode: 'auto' });
    assert.equal(response.reason, 'no_relevant_candidates');
    assert.equal(response.observations.length, 0);
    const visible = progressiveSearchToolResult(response).content[0].text;
    assert.match(visible, /Automatic search: index\./);
    assert(!visible.includes('Automatic search: index → context → selected details.'));
    assert(!f.calls.some(item => item.operation === 'fetch'));
    const guidedResponse = await f.engine.run({ query: 'authentication', mode: 'guided' });
    assert.equal(guidedResponse.complete, false);
    assert.equal(guidedResponse.index[0].id, 'semantic');
  });
  await check(async () => {
    let searches = 0;
    const f = fixture(Implementation, { search: async () => ++searches === 1 ? [row('semantic', 'Auth redirect cycle')] : [] });
    const response = await f.engine.run({ query: 'How did we fix the login loop', mode: 'auto' });
    assert.equal(response.reason, 'no_relevant_candidates');
    assert.equal(response.complete, false);
    assert.equal(response.index[0].id, 'semantic');
    assert(response.continuation);
    const next = await f.engine.run({ continuation: response.continuation, selectedIds: ['semantic'] });
    assert.equal(next.step, 2);
  });
  await check(async () => {
    const f = fixture(Implementation, {
      search: async () => Array.from({ length: 100 }, (_, i) => row(String(i + 1), 'Authentication ' + '\u0001'.repeat(500) + '😀'.repeat(300))),
      timeline: async ({ anchor }) => Array.from({ length: 100 }, (_, i) => row(`${anchor.id}:${i}`, '\u0001'.repeat(500), 'fixture' + '\u0001'.repeat(220))),
    });
    const first = await f.engine.run({ query: 'authentication', maxDetails: 5 });
    assert(first.index.length <= 20); assert(byteSize(first) <= 64 * 1024);
    assert(first.index.every((item) => Buffer.byteLength(item.title) <= 240));
    const second = await f.engine.run({ continuation: first.continuation, selectedIds: first.index.slice(0, 5).map((item) => item.id) });
    assert(second.index.length <= 35); assert(byteSize(second) <= 64 * 1024);
  });
  await check(async () => {
    const badProject = 'x' + '\u0001'.repeat(230);
    const rows = Array.from({ length: 20 }, (_, i) => row(`id-${i}`, 'Authentication ' + '\u0001'.repeat(300), badProject));
    const f = fixture(Implementation, {
      search: async () => rows,
      timeline: async ({ anchor }) => Array.from({ length: 7 }, (_, i) => row(`${anchor.id}:${i}`, '\u0001'.repeat(300), badProject)),
      fetch: async (refs) => refs.map(ref => ({ ...ref, content: '\u0000'.repeat(200_000), truncated: false })),
    });
    const first = await f.engine.run({ query: 'authentication', maxDetails: 5 });
    assert(byteSize(first) <= 64 * 1024);
    const second = await f.engine.run({ continuation: first.continuation, selectedIds: first.index.slice(0, 5).map((item) => item.id) });
    assert(byteSize(second) <= 64 * 1024); assert(second.index.length <= 35);
    assert.equal(second.trace[1].count, 35);
    assert.equal(second.continuation!.length, 27);
    assert.equal(second.reason, 'index_truncated');
    assert(second.index.length < 35);
    assert.deepEqual(f.states.at(-1)!.eligible.map(item => item.id), second.index.map(item => item.id));
    await assert.rejects(f.engine.run({ continuation: second.continuation, selectedIds: ['never-disclosed'] }), /not disclosed/);
    const third = await f.engine.run({ continuation: second.continuation, selectedIds: second.index.slice(0, 5).map((item) => item.id) });
    assert(byteSize(third) <= 64 * 1024); assert.equal(third.observations.length, 5);
    assert(third.observations.every((item) => item.truncated));
  });
  await check(async () => {
    const f = fixture(Implementation, { search: async () => [] });
    const result = await f.engine.run({ query: 'nothing' }); assert.equal(result.reason, 'no_results'); assert.equal(result.continuation, null);
    const g = fixture(Implementation); const first = await g.engine.run({ query: 'authentication' });
    const stopped = await g.engine.run({ continuation: first.continuation, selectedIds: [] }); assert.equal(stopped.reason, 'caller_stopped');
  });
  await check(async () => {
    let probes = 0;
    const f = fixture(Implementation, { search: async () => [], noResultsGuidance: async () => { probes++; return 'Enable memory sync to fill this account.'; } });
    for (const mode of ['guided', 'auto'] as const) {
      const response = await f.engine.run({ query: 'How did we fix authentication', mode });
      assert.equal(response.reason, 'no_results');
      assert.equal(response.guidance, 'Enable memory sync to fill this account.');
      assert.equal(response.continuation, null);
      assert.equal(response.next, null);
      assert.equal(response.complete, true);
    }
    assert.equal(probes, 2, 'Account advice runs once after each final empty index, not after each refinement');
  });
  await check(async () => {
    let probes = 0;
    const f = fixture(Implementation, { noResultsGuidance: async () => { probes++; return 'SHOULD_NOT_BE_SHOWN'; } });
    const complete = await f.engine.run({ query: 'authentication', mode: 'auto' });
    assert.equal(complete.guidance, null);
    const semantic = fixture(Implementation, { search: async () => [row('semantic', 'Credentials rotation')], noResultsGuidance: f.backend.noResultsGuidance });
    const handoff = await semantic.engine.run({ query: 'How did we fix authentication', mode: 'auto' });
    assert.equal(handoff.reason, 'no_relevant_candidates');
    assert.equal(handoff.guidance, null);
    assert.equal(probes, 0, 'Semantic hits must not trigger empty-account setup advice');
  });
  await check(async () => {
    const f = fixture(Implementation, { search: async () => [], noResultsGuidance: async () => { throw new Error('PRIVATE_BACKEND_FAILURE'); } });
    const response = await f.engine.run({ query: 'nothing' });
    assert.equal(response.reason, 'no_results');
    assert.equal(response.guidance, null);
    assert(!JSON.stringify(response).includes('PRIVATE_BACKEND_FAILURE'));
  });
  await check(async () => {
    const f = fixture(Implementation, { search: async () => [], noResultsGuidance: async () => '😀'.repeat(2000) });
    const response = await f.engine.run({ query: 'nothing' });
    assert(Buffer.byteLength(response.guidance!) <= 2048);
  });
  await check(async () => {
    const f = fixture(Implementation);
    const first = await f.engine.run({ query: 'authentication', project: 'fixture' });
    assert.match(first.continuation!, /^ms_[A-Za-z0-9_-]{24}$/);
    assert.equal(first.continuation!.length, 27);
    const visible = progressiveSearchToolResult(first);
    assert.equal(Object.hasOwn(visible, 'structuredContent'), false);
    assert.throws(() => JSON.parse(visible.content[0].text));
    assert.match(visible.content[0].text, /mem-search step 1 of 3/);
    assert.match(visible.content[0].text, /\[1\] Authentication fix/);
    assert.match(visible.content[0].text, /Continue with: ms_/);
    assert.match(visible.content[0].text, /Next: mem-search step 2 of 3/);
    for (const hidden of ['expiresAt', 'eligible', 'fixture-scope', 'strategy', 'trace', 'structuredContent', 'NEVER_IN_INDEX']) {
      assert(!visible.content[0].text.includes(hidden), `Internal ${hidden} must not reach the model`);
    }
    const next = await f.engine.run({ continuation: first.continuation, selectedIds: ['1'] });
    const details = await f.engine.run({ continuation: next.continuation, selectedIds: ['4'] });
    const text = progressiveSearchToolResult(details).content[0].text;
    assert.match(text, /mem-search step 3 of 3/);
    assert.match(text, /DETAIL_4/);
    assert(!text.includes('DETAIL_1'));
    assert(!text.includes('Continue with:'));
  });
  await check(async () => {
    const text = renderMemoryContent({ narrative: 'A verified fix.', facts: '["A useful fact"]', learned: 'Keep search bounded.', memory_session_id: 'PRIVATE_SESSION', device_id: 'PRIVATE_DEVICE', unknown: 'PRIVATE_UNKNOWN' });
    assert.match(text, /A verified fix/);
    assert.match(text, /A useful fact/);
    assert.match(text, /Keep search bounded/);
    assert(!text.includes('PRIVATE_'));
    assert.equal(renderMemoryContent({ unknown: 'PRIVATE_UNKNOWN' }), '');
    assert.equal(renderMemoryContent('[Memory note] Keep useful Markdown.'), '[Memory note] Keep useful Markdown.');
  });
  await check(async () => {
    const f = fixture(Implementation);
    const first = await f.engine.run({ query: 'authentication' });
    const restarted = new Implementation(f.backend, { secret, scope: 'fixture-scope', cursorStore: f.cursorStore, newCursor: f.newCursor, now: () => 1000 });
    const next = await restarted.run({ continuation: first.continuation, selectedIds: ['1'] });
    assert.equal(next.step, 2, 'A new engine instance uses server-side state');
    const cleared = new Implementation(f.backend, { secret, scope: 'fixture-scope', cursorStore: new MemoryProgressiveCursorStore(), now: () => 1000 });
    await assert.rejects(cleared.run({ continuation: first.continuation, selectedIds: ['1'] }), /unavailable/);
  });
  await check(async () => {
    const store = new MemoryProgressiveCursorStore({ now: () => 1000, maxEntries: 2 });
    const f = fixture(Implementation);
    const engine = new Implementation(f.backend, { secret, scope: 'bounded', cursorStore: store, newCursor: f.newCursor, now: () => 1000 });
    const first = await engine.run({ query: 'authentication' });
    const second = await engine.run({ query: 'authentication' });
    await engine.run({ query: 'authentication' });
    await assert.rejects(engine.run({ continuation: first.continuation, selectedIds: ['1'] }), /unavailable/);
    assert.equal((await engine.run({ continuation: second.continuation, selectedIds: ['1'] })).step, 2);
  });
  await check(async () => {
    const result = progressiveSearchToolError(new Error('PRIVATE_BACKEND_SQL_AND_CREDENTIALS'));
    assert.equal(result.isError, true);
    assert.throws(() => JSON.parse(result.content[0].text));
    assert.match(result.content[0].text, /Memory retrieval failed/);
    assert.match(result.content[0].text, /Next: restart mem_search/);
    assert(!result.content[0].text.includes('PRIVATE_'));
  });
  await check(async () => {
    const projected = projectMemoryContent({ narrative: 'x'.repeat(40000), facts: Array.from({ length: 13 }, (_, i) => `Fact ${i}`) });
    assert.equal(projected.truncated, true);
    assert(Buffer.byteLength(projected.text) < 40000);
    const ordinary = projectMemoryContent({ narrative: 'Concise factual note.', unknown: 'INTERNAL_METADATA' });
    assert.equal(ordinary.truncated, false);
    assert.equal(ordinary.text, 'Concise factual note.');
  });
  return { count, guided, auto };
}
