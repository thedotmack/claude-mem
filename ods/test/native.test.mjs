import test from 'node:test';
import assert from 'node:assert/strict';
import { createOdsMemory, memoryConfigFromEnv } from '../native/claude_mem.mjs';

const sessionId = `ods-${'a'.repeat(64)}`;
const messages = [{ role: 'user', content: 'Keep the accent blue.' }];
const completion = { choices: [{ message: { content: 'I kept the accent blue.' } }] };

function fixture(options = {}) {
  const calls = [], warnings = [];
  const memory = createOdsMemory({
    enabled: true,
    logger: { warn: value => warnings.push(value) },
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), method: init.method, body: init.body && JSON.parse(init.body), init });
      return String(url).includes('/api/observations?')
        ? Response.json({ items: [{ title: 'Earlier decision', narrative: '<blue> & yellow.' }] })
        : Response.json({ status: 'queued' });
    },
    ...options,
  });
  return { memory, calls, warnings, turn: memory.turn({ sessionId, requestId: 'turn-1', messages }) };
}

test('disabled native integration does no I/O', async () => {
  const { memory, calls } = fixture({ enabled: false });
  assert.equal(memory.turn({ sessionId, messages }), null);
  await memory.forget(sessionId);
  assert.equal(calls.length, 0);
});

test('configuration defaults to local, isolated, and opt-in', () => {
  assert.deepEqual(memoryConfigFromEnv({}), { enabled: false, url: 'http://127.0.0.1:37778', scope: 'conversation' });
  assert.equal(memoryConfigFromEnv({ ODS_CLAUDE_MEM_ENABLED: 'true' }).enabled, true);
  for (const url of ['https://example.com', 'http://evil.test', 'http://127.0.0.1/private', 'http://u:p@127.0.0.1']) {
    assert.throws(() => createOdsMemory({ url }), /loopback/);
  }
  assert.throws(() => memoryConfigFromEnv({ ODS_CLAUDE_MEM_PORT: '0' }), /PORT/);
  assert.throws(() => memoryConfigFromEnv({ ODS_CLAUDE_MEM_SCOPE: 'from-model' }), /SCOPE/);
});

test('native init and bounded recall preserve identities and mark memory as historical data', async () => {
  const { turn, calls } = fixture();
  const context = await turn.prepare();
  assert.equal(calls[0].body.platformSource, 'ods');
  assert.equal(calls[0].body.contentSessionId, sessionId);
  assert.equal(calls[0].body.nativePromptId, 'turn-1');
  assert.equal(calls[0].body.project, `ods/${'a'.repeat(64)}`);
  assert.equal(calls[1].url.searchParams.get('project'), calls[0].body.project);
  assert.match(context.content, /reference data/);
  assert.match(context.content, /&lt;blue&gt; &amp; yellow/);
  assert.equal(context.role, 'system');
  assert.equal(await turn.prepare(), null, 'never inject twice for one request');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.redirect, 'error');
});

test('activity and final answers are ordered after init, deduplicated, and attributed to ODS', async () => {
  const { turn, memory, calls } = fixture();
  await turn.prepare();
  const task = { runId: 'run-1', events: [
    { sequence: 1, state: 'running', kind: 'read' },
    { sequence: 2, state: 'completed', kind: 'edit', display: null, startedAt: 'start', finishedAt: 'end' },
  ] };
  turn.activity(task);
  turn.activity(task);
  turn.complete(completion, { status: 'none' });
  turn.complete(completion);
  await memory.flush();
  const writes = calls.slice(2);
  assert.deepEqual(writes.map(call => call.body.tool_name || 'summarize'), [
    'ODSActivity', 'ODSConversation', 'ODSVerification', 'summarize',
  ]);
  assert.match(writes[0].body.tool_response, /not independent proof/);
  assert.equal(writes[1].body.tool_use_id, 'ods:turn-1:answer');
  assert.equal(writes[1].body.tool_response, 'I kept the accent blue.');
  assert.equal(writes[3].body.last_assistant_message, 'I kept the accent blue.');
  assert.ok(writes.every(call => call.body.platformSource === 'ods'));
});

test('privacy skip records neither a response nor a context lookup', async () => {
  let requests = 0;
  const { memory, turn } = fixture({ fetchImpl: async () => {
    requests++;
    return Response.json({ skipped: true, reason: 'private' });
  } });
  assert.equal(await turn.prepare(), null);
  turn.complete(completion);
  await memory.flush();
  assert.equal(requests, 1, 'only the privacy check is submitted');
});

test('private blocks are removed before truncating every captured payload', async () => {
  const { memory, calls } = fixture();
  const secret = '<private>' + 'SECRET'.repeat(14000) + '</private>';
  const turn = memory.turn({ sessionId, requestId: 'private-boundary', messages: [
    { role: 'user', content: `Public prompt. ${secret} Safe suffix.` },
  ] });
  await turn.prepare();
  turn.activity({ runId: 'run-private', events: [{ sequence: 1, state: 'completed', kind: 'edit',
    display: { label: `Public activity. ${secret} Safe activity suffix.` } }] });
  turn.complete({ choices: [{ message: { content: `Public answer. ${secret} Safe answer suffix.` } }] },
    { status: 'none', detail: secret });
  await memory.flush();
  assert.doesNotMatch(JSON.stringify(calls), /SECRET|<\/?private>/);
  assert.equal(calls[0].body.prompt, 'Public prompt.  Safe suffix.');
  const writes = calls.filter(call => call.body?.tool_name);
  assert.match(writes.find(call => call.body.tool_name === 'ODSActivity').body.tool_response, /Safe activity suffix/);
  assert.equal(writes.find(call => call.body.tool_name === 'ODSConversation').body.tool_response,
    'Public answer.  Safe answer suffix.');
  assert.equal(calls.at(-1).body.last_assistant_message, 'Public answer.  Safe answer suffix.');
});

test('nested and unfinished private blocks cannot escape capture filtering', async () => {
  const { memory, calls } = fixture();
  const turn = memory.turn({ sessionId, messages: [{ role: 'user',
    content: 'Public. <PRIVATE>SECRET<private>SECRET</private>SECRET</private invalid>SECRET</PRIVATE> Safe. <private>SECRET' }] });
  await turn.prepare();
  turn.complete({ choices: [{ message: { content: 'Public answer. <private unfinished SECRET' } }] });
  await memory.flush();
  assert.equal(calls[0].body.prompt, 'Public.  Safe. ');
  assert.doesNotMatch(JSON.stringify(calls), /SECRET/);
});

test('an entirely private prompt skips the whole turn before any I/O', () => {
  const { memory, calls } = fixture();
  assert.equal(memory.turn({ sessionId, messages: [{ role: 'user', content: '<private>SECRET</private>' }] }), null);
  assert.equal(calls.length, 0);
});

test('recall and network failures fail softly without logging conversation contents', async () => {
  const { memory, turn, warnings } = fixture({ fetchImpl: async () => { throw new Error('secret prompt, API key'); } });
  assert.equal(await turn.prepare(), null);
  turn.complete(completion);
  await memory.flush();
  assert.deepEqual(warnings, ['[claude-mem:ods] memory-unavailable']);
  assert.equal(memory.status().lastError, 'memory-unavailable');
});

test('oversized context is rejected before injecting it', async () => {
  let request = 0;
  const { turn, memory } = fixture({ fetchImpl: async () => ++request === 1
    ? Response.json({ status: 'queued' }) : new Response('x'.repeat(140_000)) });
  assert.equal(await turn.prepare(), null);
  assert.equal(memory.status().lastError, 'memory-response-too-large');
});

test('one failed write stops downstream summary instead of storing an incomplete turn', async () => {
  let request = 0;
  const { turn, memory } = fixture({ fetchImpl: async () => {
    request++;
    if (request === 1) return Response.json({});
    if (request === 2) return Response.json({ items: [] });
    return new Response('', { status: 503 });
  } });
  await turn.prepare();
  turn.complete(completion, { status: 'none' });
  await memory.flush();
  assert.equal(request, 3);
  assert.equal(memory.status().pending, 0);
  assert.equal(memory.status().lastError, 'memory-unavailable');
});

test('conversation deletion fences late observations and removes its exact native session', async () => {
  const { turn, memory, calls } = fixture();
  await turn.prepare();
  turn.complete(completion);
  await memory.forget(sessionId);
  turn.activity({ runId: 'late', events: [{ sequence: 9, state: 'completed' }] });
  await memory.flush();
  const last = calls.at(-1);
  assert.equal(last.method, 'DELETE');
  assert.equal(last.url.pathname, `/api/sessions/ods/${sessionId}`);
  assert.equal(await memory.turn({ sessionId, messages }).prepare(), null);
});

test('installation-wide sharing is an operator-selected scope', async () => {
  const { turn, calls } = fixture({ scope: 'installation' });
  await turn.prepare();
  assert.equal(calls[0].body.project, 'ods');
});

test('escaping hostile note text still respects the context budget', async () => {
  const { turn } = fixture({ fetchImpl: async url => String(url).includes('/api/observations?')
    ? Response.json({ items: Array.from({ length: 5 }, () => ({ title: 'Note', narrative: '<'.repeat(2000) })) })
    : Response.json({}) });
  const context = await turn.prepare();
  assert.ok(Buffer.byteLength(context.content) <= 12 * 1024);
});

test('deleting a never-captured session is idempotent', async () => {
  const { memory } = fixture({ fetchImpl: async () => new Response('', { status: 404 }) });
  await memory.forget(sessionId);
});
