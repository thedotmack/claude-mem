import assert from 'node:assert/strict';
import { renderMemoryContent, projectMemoryContent, progressiveSearchToolResult, progressiveSearchToolError, type ProgressiveSearch, ProgressiveBackend, ProgressiveSearchInput, ProgressiveSearchResult, MemoryIndexRow } from '../../src/shared/progressive-search.js';
import { WorkerRequestTimeoutError } from '../../src/shared/worker-request-timeout-error.js';

type Engine = typeof ProgressiveSearch;
const row = (id: string, title = 'Authentication fix', project = 'fixture', kind: MemoryIndexRow['kind'] = 'observation'): MemoryIndexRow => ({ id, title, project, kind, createdAt: 1000, type: 'decision' });
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function fixture(Implementation: Engine, overrides: Partial<ProgressiveBackend> = {}) {
  const calls: { operation: string; ids?: string[]; query?: string }[] = [];
  const backend: ProgressiveBackend = {
    search: async (input) => { calls.push({ operation: 'search', query: input.query }); return [{ ...row('1'), narrative: 'NEVER_IN_INDEX' }, row('2', 'Unrelated gardening'), row('P3', 'Authentication prompt', 'fixture', 'prompt')]; },
    timeline: async ({ anchor }) => { calls.push({ operation: 'timeline', ids: [anchor.id] }); return [anchor, row('4', 'Authentication correction'), row('P5', 'Authentication prompt', 'fixture', 'prompt'), row('foreign', 'Authentication foreign', 'foreign')]; },
    fetch: async (refs) => { calls.push({ operation: 'fetch', ids: refs.map(ref => ref.id) }); return [...refs.map(ref => ({ ...ref, content: `DETAIL_${ref.id}`, truncated: false })), { ...row('injected'), content: 'NEVER_UNSELECTED', truncated: false }]; },
    ...overrides,
  };
  return { engine: new Implementation(backend), backend, calls };
}

/** Shared dumb-search cases used by cloud and worker; no live memory or network. */
export async function runProgressiveSearchCases(Implementation: Engine): Promise<{ count: number; flash: ProgressiveSearchResult | undefined }> {
  let count = 0;
  const check = async (body: () => void | Promise<void>) => { await body(); count++; };
  let flash: ProgressiveSearchResult | undefined;
  await check(async () => {
    const f = fixture(Implementation);
    flash = await f.engine.run({ query: 'authentication', project: 'fixture', maxDetails: 2 });
    assert.equal(flash.step, 3);
    assert.deepEqual(flash.trace.map((item) => item.operation), ['search', 'timeline', 'fetch']);
    assert(flash.observations.length <= 2);
    assert.deepEqual(f.calls.filter(item => item.operation === 'fetch').map(item => item.ids), [['1', '4']]);
    assert(flash.observations.every(item => item.project === 'fixture'));
    assert(!JSON.stringify(flash).includes('NEVER_UNSELECTED'));
    const text = progressiveSearchToolResult(flash).content[0].text;
    assert.match(text, /^dumb-search — selected details/);
    assert.match(text, /Doesn’t reason about the results. Fast, but shallow. Use Smart for reliable recall./);
    assert.match(text, /index → timeline context → selected details/);
  });
  for (const input of [
    { query: '' }, { query: 'x'.repeat(501) }, { query: '😀'.repeat(300) },
    { query: 'authentication', mode: 'auto' }, { query: 'authentication', mode: 'guided' },
    { query: 'authentication', continuation: 'old-cursor' },
    { query: 'authentication', limit: 0 }, { query: 'authentication', limit: 21 },
    { query: 'authentication', limit: 1.5 }, { query: 'authentication', maxDetails: 6 },
    { query: 'authentication', depthBefore: -1 }, { query: 'authentication', depthAfter: 4 },
  ]) await check(async () => { await assert.rejects(fixture(Implementation).engine.run(input as ProgressiveSearchInput)); });
  await check(async () => {
    const f = fixture(Implementation, { search: async () => [row('semantic', 'Credentials rotation')] });
    const response = await f.engine.run({ query: 'authentication' });
    assert.equal(response.reason, 'no_relevant_candidates');
    assert.equal(response.observations.length, 0);
    assert.equal(response.index[0].id, 'semantic');
    const visible = progressiveSearchToolResult(response).content[0].text;
    assert.match(visible, /Ran index,/);
    assert.match(visible, /index → timeline context → selected details/);
    assert(!f.calls.some(item => item.operation === 'fetch'));
  });
  await check(async () => {
    let searches = 0;
    const f = fixture(Implementation, { search: async () => ++searches === 1 ? [row('semantic', 'Auth redirect cycle')] : [] });
    const response = await f.engine.run({ query: 'How did we fix the login loop' });
    assert.equal(response.reason, 'no_relevant_candidates');
    assert.equal(response.index[0].id, 'semantic');
    assert.equal(searches, 2, 'One bounded query refinement');
  });
  await check(async () => {
    const f = fixture(Implementation, {
      search: async () => Array.from({ length: 100 }, (_, i) => row(String(i + 1), 'Authentication ' + '\u0001'.repeat(500) + '😀'.repeat(300))),
      timeline: async ({ anchor }) => Array.from({ length: 100 }, (_, i) => row(`${anchor.id}:${i}`, '\u0001'.repeat(500), 'fixture' + '\u0001'.repeat(220))),
      fetch: async (refs) => refs.map(ref => ({ ...ref, content: '\u0000'.repeat(200_000), truncated: false })),
    });
    const response = await f.engine.run({ query: 'authentication', maxDetails: 5 });
    assert(byteSize(response) <= 64 * 1024);
    assert(response.observations.length <= 5);
  });
  await check(async () => {
    const f = fixture(Implementation, { search: async () => [] });
    const result = await f.engine.run({ query: 'nothing' });
    assert.equal(result.reason, 'no_results');
  });
  await check(async () => {
    let probes = 0;
    const f = fixture(Implementation, { search: async () => [], noResultsGuidance: async () => { probes++; return 'Enable memory sync to fill this account.'; } });
    const response = await f.engine.run({ query: 'How did we fix authentication' });
    assert.equal(response.reason, 'no_results');
    assert.equal(response.guidance, 'Enable memory sync to fill this account.');
    assert.equal(probes, 1, 'Account advice runs once after the final empty index, not after each refinement');
  });
  await check(async () => {
    let probes = 0;
    const f = fixture(Implementation, { noResultsGuidance: async () => { probes++; return 'SHOULD_NOT_BE_SHOWN'; } });
    const complete = await f.engine.run({ query: 'authentication' });
    assert.equal(complete.guidance, null);
    const semantic = fixture(Implementation, { search: async () => [row('semantic', 'Credentials rotation')], noResultsGuidance: f.backend.noResultsGuidance });
    const handoff = await semantic.engine.run({ query: 'How did we fix authentication' });
    assert.equal(handoff.reason, 'no_relevant_candidates');
    assert.equal(handoff.guidance, null);
    assert.equal(probes, 0, 'Semantic hits must not trigger empty-account setup advice');
  });
  await check(async () => {
    const f = fixture(Implementation, { search: async () => [], noResultsGuidance: async () => { throw new Error('PRIVATE_BACKEND_FAILURE'); } });
    const response = await f.engine.run({ query: 'nothing' });
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
    const visible = progressiveSearchToolResult(await f.engine.run({ query: 'authentication', project: 'fixture' }));
    assert.equal(Object.hasOwn(visible, 'structuredContent'), false);
    assert.throws(() => JSON.parse(visible.content[0].text));
    for (const hidden of ['trace', 'structuredContent', 'NEVER_IN_INDEX', 'Continue with:', 'mode=']) {
      assert(!visible.content[0].text.includes(hidden), `Internal ${hidden} must not reach the model`);
    }
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
    const result = progressiveSearchToolError(new Error('PRIVATE_BACKEND_SQL_AND_CREDENTIALS'));
    assert.equal(result.isError, true);
    assert.throws(() => JSON.parse(result.content[0].text));
    assert.match(result.content[0].text, /Memory retrieval failed/);
    assert.match(result.content[0].text, /Next: retry dumb_search/);
    assert(!result.content[0].text.includes('PRIVATE_'));

    const timeoutResult = progressiveSearchToolError(new WorkerRequestTimeoutError(30000));
    assert.equal(timeoutResult.isError, true);
    assert.match(timeoutResult.content[0].text, /The local worker did not answer within 30000ms\./);
    assert.match(timeoutResult.content[0].text, /Next: retry dumb_search/);

    // Only the typed worker-client timeout is disclosed; backend text that also says "timed out" stays masked.
    for (const backendTimeout of [
      new Error('chroma-mcp timed out after 5000ms: PRIVATE_x'),
      new Error('Request timed out after 30000ms PRIVATE_y'),
    ]) {
      const masked = progressiveSearchToolError(backendTimeout);
      assert.match(masked.content[0].text, /Memory retrieval failed/);
      assert(!masked.content[0].text.includes('PRIVATE_'));
      assert(!masked.content[0].text.includes('timed out'));
    }
  });
  await check(async () => {
    const projected = projectMemoryContent({ narrative: 'x'.repeat(40000) });
    assert.equal(projected.truncated, true);
    assert(Buffer.byteLength(projected.text) < 40000);
    const ordinary = projectMemoryContent({ narrative: 'Concise factual note.', unknown: 'INTERNAL_METADATA' });
    assert.equal(ordinary.truncated, false);
    assert.equal(ordinary.text, 'Concise factual note.');
    const complete = projectMemoryContent({ facts: Array.from({ length: 30 }, (_, i) => `Fact ${i}`), concepts: ['how-it-works', 'gotcha'] });
    assert.match(complete.text, /Fact 29/, 'Every fact is kept, as in the full get_observations record');
    assert.match(complete.text, /Concepts: how-it-works, gotcha/);
  });
  for (const narrative of ['{"timeoutSeconds":30}', '["use staging"]']) await check(async () => {
    const projected = projectMemoryContent({ narrative, memory_session_id: 'PRIVATE_SESSION' });
    assert.equal(projected.text, narrative);
    assert.equal(renderMemoryContent(projected.text), narrative, 'Selected note prose must survive rendering twice');
    const f = fixture(Implementation, {
      fetch: async refs => refs.map(ref => ({ ...ref, content: projected.text, truncated: false })),
    });
    const visible = progressiveSearchToolResult(await f.engine.run({ query: 'authentication', maxDetails: 1 })).content[0].text;
    assert(visible.includes(narrative), 'A selected JSON example is evidence, not a protocol record');
    assert(!visible.includes('PRIVATE_SESSION'));
    assert.throws(() => JSON.parse(visible), 'The tool reply remains purpose-specific prose');
  });
  await check(async () => {
    const text = renderMemoryContent({
      completed: 'Updated the memory bridge.',
      files_edited: '["src/memory-bridge.ts", "tests/memory-bridge.test.ts"]',
      files_read: ['README.md'], memory_session_id: 'PRIVATE_SESSION',
    });
    assert.match(text, /Files changed: src\/memory-bridge\.ts, tests\/memory-bridge\.test\.ts/);
    assert.match(text, /Files read: README\.md/);
    assert(!text.includes('PRIVATE_SESSION'));
  });
  return { count, flash };
}
