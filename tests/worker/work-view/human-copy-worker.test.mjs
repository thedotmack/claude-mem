import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanCopyWorker, chatCompletionsHumanCopyProvider, fitGeneratedCopy } from '../../../src/services/work-view/human-copy-worker.mjs';
import { createHumanCopyInput, validateHumanCopy } from '../../../src/services/work-view/human-copy.mjs';

const request = (id = 'request-one', progress = 'The local source is connected.') => ({
  id, original: { text: 'Show my work in a live tracker.', source: 'user-prompt', sourceId: 10 },
  scopeUpdates: [], lifecycle: null, updatedAtEpoch: 1000,
  workstreams: [{ id: `${id}:stream`, items: [{
    id: 'task-one', title: 'Connect recorded work', status: 'doing',
    progress: { text: progress }, nextStep: { text: 'Verify mobile layout.' },
    sourceRefs: [{ kind: 'work-state', id: 1 }], lastUpdateEpoch: 1000,
  }], activity: [] }],
});
const view = (...humanRequests) => ({ humanRequests });
const copy = (input, title = 'See work clearly') => ({
  title, summary: 'Recorded work is available in one place.', next: 'Check the mobile layout.',
  workstreams: input.workstreams.map(stream => ({ id: stream.id, title: 'Connect your work', summary: 'The recorded source is connected.' })),
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const worker = (provider, options = {}) => new HumanCopyWorker({
  provider, cachePath: null, quietMs: 0, minIntervalMs: 0, retryMs: 1000, warn: () => {},
  now: () => 1000, ...options,
});
const waitForWorker = async instance => {
  for (let i = 0; i < 100 && instance.running.size; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(instance.running.size, 0, 'worker request settles');
};

test('setup pause suppresses already queued and newly observed user-token calls until setup completes', async t => {
  let paused = false, now = 0, calls = 0;
  const instance = worker(async input => { calls++; return { output: copy(input) }; }, { now: () => now, quietMs: 100 });
  t.after(() => instance.close());
  instance.pauseWhile(() => paused);
  instance.observe(view(request()));
  assert.equal(instance.status().queued, 1);
  paused = true;
  now = 1000;
  instance.pump();
  instance.observe(view(request('request-two')));
  assert.equal(calls, 0);
  assert.equal(instance.status().queued, 1);
  paused = false;
  instance.pump();
  await settle();
  assert.equal(calls, 1);
});

test('one request stays single-flight and reuses its copy across polling, source ages and display-label changes', async t => {
  let calls = 0;
  const pending = deferred();
  const source = request();
  const instance = worker(async input => { calls++; return pending.promise; });
  t.after(() => instance.close());
  for (let i = 0; i < 8; i++) instance.observe(view(source));
  assert.equal(calls, 1);
  pending.resolve({ output: copy(createHumanCopyInput(source)) });
  await settle();
  const changedMetadata = structuredClone(source);
  changedMetadata.title = 'A cached presentation label';
  changedMetadata.updatedAtEpoch = 9000;
  changedMetadata.workstreams[0].items[0].lastUpdateEpoch = 9000;
  for (let i = 0; i < 8; i++) assert.equal(instance.observe(view(changedMetadata)).humanRequests[0].humanCopy.state, 'current');
  assert.equal(calls, 1);
});

test('new unrelated requests generate only their own copy and one call includes every workstream', async t => {
  const inputs = [];
  const source = request();
  source.workstreams.push({ id: 'second-stream', items: [], activity: [] });
  const instance = worker(async input => { inputs.push(input); return { output: copy(input) }; });
  t.after(() => instance.close());
  instance.observe(view(source));
  await settle();
  instance.observe(view(source, request('request-two')));
  await settle();
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].workstreams.length, 2);
  assert.equal(instance.observe(view(source)).humanRequests[0].humanCopy.state, 'current');
  assert.equal(inputs.length, 2);
});

test('a changed in-flight input never publishes stale copy and the next call uses the latest input', async t => {
  const jobs = [];
  const instance = worker(async input => {
    const job = { input, ...deferred() }; jobs.push(job); return job.promise;
  });
  t.after(() => instance.close());
  const first = request(), latest = request('request-one', 'Mobile layout is now verified.');
  instance.observe(view(first));
  instance.observe(view(latest));
  assert.equal(jobs.length, 1);
  jobs[0].resolve({ output: copy(jobs[0].input, 'Old copy') });
  await settle();
  assert.equal(instance.cache.has(first.id), false);
  assert.equal(jobs.length, 2);
  assert.match(jobs[1].input.workstreams[0].currentItems[0].progress, /Mobile layout/);
  jobs[1].resolve({ output: copy(jobs[1].input, 'Latest copy') });
  await settle();
  assert.equal(instance.observe(view(latest)).humanRequests[0].humanCopy.title, 'Latest copy');
});

test('per-request minimum interval prevents costly repeated generations for changing work', async t => {
  let now = 1000, calls = 0;
  const instance = worker(async input => { calls++; return { output: copy(input) }; }, { now: () => now, minIntervalMs: 1000 });
  t.after(() => instance.close());
  instance.observe(view(request())); await settle();
  now = 1100;
  const changed = request('request-one', 'A new supported result is recorded.');
  assert.equal(instance.observe(view(changed)).humanRequests[0].humanCopy.state, 'outdated');
  now = 1999; instance.pump(); assert.equal(calls, 1);
  now = 2000; instance.pump(); await settle();
  assert.equal(calls, 2);
  assert.equal(instance.observe(view(changed)).humanRequests[0].humanCopy.state, 'current');
});

test('a burst is debounced while maximum wait eventually processes its newest content', async t => {
  let now = 0;
  const inputs = [];
  const instance = worker(async input => { inputs.push(input); return { output: copy(input) }; }, { now: () => now, quietMs: 100, maxWaitMs: 300 });
  t.after(() => instance.close());
  for (const at of [0, 80, 160, 240]) {
    now = at; instance.observe(view(request('request-one', `Supported update ${at}.`)));
  }
  assert.equal(inputs.length, 0);
  now = 320; instance.observe(view(request('request-one', 'Supported latest update.')));
  await settle();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].workstreams[0].currentItems[0].progress, 'Supported latest update.');
});

test('provider failure preserves last good copy, reports it outdated, and respects retry timing', async t => {
  let now = 1000, calls = 0;
  const instance = worker(async input => {
    calls++;
    if (calls === 2) throw new Error('Temporary gateway failure');
    return { output: copy(input, calls === 1 ? 'Last good copy' : 'Recovered copy') };
  }, { now: () => now, retryMs: 100 });
  t.after(() => instance.close());
  instance.observe(view(request())); await settle();
  const changed = request('request-one', 'The underlying work changed.');
  now = 1010; instance.observe(view(changed)); await settle();
  const outdated = instance.observe(view(changed)).humanRequests[0].humanCopy;
  assert.equal(outdated.state, 'outdated');
  assert.equal(outdated.title, 'Last good copy');
  now = 1109; instance.pump(); assert.equal(calls, 2);
  now = 1110; instance.pump(); await settle();
  assert.equal(calls, 3);
  assert.equal(instance.observe(view(changed)).humanRequests[0].humanCopy.title, 'Recovered copy');
});

test('permanent HTTP failures are logged safely and wait for provider configuration changes', async t => {
  let now = 1000, configKey = 'first-config', calls = 0;
  const warnings = [];
  const directory = mkdtempSync(join(tmpdir(), 'human-copy-failure-'));
  const provider = Object.assign(async input => {
    calls++;
    if (configKey === 'first-config') throw Object.assign(new Error('Bearer secret-response-detail'), { status: 404 });
    return { output: copy(input, 'Recovered after settings change') };
  }, { getConfigKey: () => configKey });
  const instance = new HumanCopyWorker({ provider, cachePath: join(directory, 'human-copy.json'), quietMs: 0, minIntervalMs: 0,
    retryMs: 100, now: () => now, warn: message => warnings.push(message) });
  t.after(() => { instance.close(); rmSync(directory, { recursive: true, force: true }); });

  instance.observe(view(request())); await waitForWorker(instance);
  assert.equal(calls, 1);
  assert.equal(instance.status().failures[0].reason, 'HTTP 404');
  const logPath = join(directory, 'human-copy-usage.jsonl');
  const failureLine = readFileSync(logPath, 'utf8').trim();
  const failure = JSON.parse(failureLine);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.reason, 'HTTP 404');
  assert.doesNotMatch(failureLine, /secret-response-detail/);
  assert.equal(warnings.length, 1);

  now += 60 * 60 * 1000;
  instance.pump(); await waitForWorker(instance);
  assert.equal(calls, 1, 'a permanent 4xx does not retry on a timer');

  configKey = 'second-config';
  instance.observe(view(request())); await waitForWorker(instance);
  assert.equal(calls, 2, 'a provider-settings change retries immediately');
  assert.equal(instance.observe(view(request())).humanRequests[0].humanCopy.title, 'Recovered after settings change');
});

test('429 failures use exponential backoff', async t => {
  let now = 0, calls = 0;
  const instance = worker(async () => { calls++; throw Object.assign(new Error('rate limited'), { status: 429 }); },
    { now: () => now, retryMs: 100, maxRetryMs: 1000 });
  t.after(() => instance.close());
  instance.observe(view(request())); await settle();
  assert.equal(calls, 1);
  now = 99; instance.pump(); await settle(); assert.equal(calls, 1);
  now = 100; instance.pump(); await settle(); assert.equal(calls, 2);
  now = 299; instance.pump(); await settle(); assert.equal(calls, 2);
  now = 300; instance.pump(); await settle(); assert.equal(calls, 3);
});

test('invalid or invented output identities cannot publish copy or change recorded status', async t => {
  const source = request();
  const instance = worker(async input => ({ output: {
    ...copy(input), status: 'done', workstreams: [{ id: 'invented-stream', title: 'Done', summary: 'Everything delivered.' }],
  } }));
  t.after(() => instance.close());
  instance.observe(view(source)); await settle();
  const result = instance.observe(view(source)).humanRequests[0];
  assert.equal(result.humanCopy.state, 'unavailable');
  assert.equal(instance.cache.size, 0);
  assert.equal(result.workstreams[0].items[0].status, 'doing');
});

test('text fitting enforces display limits without repairing malformed identities or status fields', () => {
  const input = createHumanCopyInput(request());
  const long = copy(input);
  long.title = 'Useful title words '.repeat(15);
  long.summary = 'A supported sentence. '.repeat(20);
  const fitted = fitGeneratedCopy(long);
  assert.ok(fitted.title.length <= 100);
  assert.ok(fitted.summary.length <= 240);
  assert.doesNotThrow(() => validateHumanCopy(fitted, input));
  assert.throws(() => validateHumanCopy(fitGeneratedCopy({ ...long, status: 'done' }), input));
  assert.throws(() => validateHumanCopy(fitGeneratedCopy({ ...long, workstreams: [{ ...long.workstreams[0], id: 'foreign' }] }), input));
  assert.equal(fitGeneratedCopy(null), null);
  assert.equal(fitGeneratedCopy('invalid text'), 'invalid text');
});

test('unchanged current items reordered by a timestamp-only write do not incur a new generation', async t => {
  let calls = 0;
  const source = request();
  source.workstreams[0].items.push({ ...structuredClone(source.workstreams[0].items[0]), id: 'task-two', title: 'Review the result' });
  const instance = worker(async input => { calls++; return { output: copy(input) }; });
  t.after(() => instance.close());
  instance.observe(view(source)); await settle();
  const reordered = structuredClone(source);
  reordered.workstreams[0].items.reverse();
  reordered.workstreams[0].items[0].lastUpdateEpoch = 9000;
  const result = instance.observe(view(reordered));
  assert.equal(result.humanRequests[0].humanCopy.state, 'current');
  assert.equal(calls, 1);
  await settle();
});

test('a malformed stale cache entry is never published as outdated display copy', t => {
  const instance = worker(async input => ({ output: copy(input) }), { quietMs: 1000 });
  t.after(() => instance.close());
  const source = request();
  instance.cache.set(source.id, { fingerprint: 'old-fingerprint', generatedAt: 1, copy: { title: 'Invalid cached shape', workstreams: 'not-an-array' } });
  const result = instance.observe(view(source)).humanRequests[0].humanCopy;
  assert.equal(result.title, undefined);
  assert.ok(['pending', 'unavailable'].includes(result.state));
});

test('without a configured summary provider, requests are marked unavailable and nothing is queued', t => {
  const instance = new HumanCopyWorker({ provider: null, cachePath: null });
  t.after(() => instance.close());
  const result = instance.observe(view(request())).humanRequests[0].humanCopy;
  assert.equal(result.state, 'unavailable');
  assert.equal(instance.status().queued, 0);
});

test('a provider whose settings are off is not queued or called, then resolves after opt-in', async t => {
  let enabled = false, calls = 0;
  const provider = Object.assign(async input => { calls++; return { output: copy(input) }; }, { isAvailable: () => enabled });
  const instance = worker(provider);
  t.after(() => instance.close());
  const source = request();
  assert.equal(instance.observe(view(source)).humanRequests[0].humanCopy.state, 'unavailable');
  assert.equal(instance.status().queued, 0);
  assert.equal(calls, 0);

  enabled = true;
  assert.equal(instance.observe(view(source)).humanRequests[0].humanCopy.state, 'pending');
  await settle();
  assert.equal(calls, 1);
  assert.equal(instance.observe(view(source)).humanRequests[0].humanCopy.state, 'current');
});

test('explicit off hides cached wording while retaining it for later reuse', async t => {
  let enabled = true, off = false, configKey = 'enabled', calls = 0;
  const provider = Object.assign(async input => { calls++; return { output: copy(input, 'Stored wording') }; }, {
    isAvailable: () => enabled, isOff: () => off, getConfigKey: () => configKey,
  });
  const instance = worker(provider);
  t.after(() => instance.close());
  const source = request();
  instance.observe(view(source)); await settle();
  assert.equal(instance.observe(view(source)).humanRequests[0].humanCopy.title, 'Stored wording');

  enabled = false; off = true; configKey = null;
  const disabled = instance.observe(view(source)).humanRequests[0].humanCopy;
  assert.equal(disabled.state, 'unavailable');
  assert.equal(disabled.title, undefined);
  assert.equal(instance.cache.size, 1);

  enabled = true; off = false; configKey = 'enabled-again';
  const reenabled = instance.observe(view(source)).humanRequests[0].humanCopy;
  assert.equal(reenabled.state, 'current');
  assert.equal(reenabled.title, 'Stored wording');
  assert.equal(calls, 1);
});

test('a strict server that rejects the reasoning field gets one resend without it, and is remembered', async () => {
  const bodies = [];
  const provider = chatCompletionsHumanCopyProvider({
    url: 'http://127.0.0.1:8000/v1/strict-reasoning/chat/completions', apiKey: '', model: 'vllm-model',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body);
      if (Object.hasOwn(body, 'reasoning')) return new Response(JSON.stringify({ object: 'error', message: "[{'type': 'extra_forbidden', 'loc': ('body', 'reasoning'), 'msg': 'Extra inputs are not permitted'}]" }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t"}' } }] }));
    },
  });
  assert.deepEqual((await provider({ version: 1 })).output, { title: 't' });
  assert.deepEqual(bodies.map(body => Object.hasOwn(body, 'reasoning')), [true, false]);
  // The next request to that URL leaves the field out from the start.
  await provider({ version: 2 });
  assert.deepEqual(bodies.map(body => Object.hasOwn(body, 'reasoning')), [true, false, false]);
});

test('any other 400 is not resent', async () => {
  let calls = 0;
  const provider = chatCompletionsHumanCopyProvider({
    url: 'http://127.0.0.1:8000/v1/other-400/chat/completions', apiKey: '', model: 'm',
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'model is required' } }), { status: 400 }); },
  });
  await assert.rejects(provider({ version: 1 }), error => error.status === 400);
  assert.equal(calls, 1);
});

test('402 (out of credits) retries on the capped backoff instead of waiting for a settings change', async t => {
  let now = 0, calls = 0;
  const instance = worker(async () => { calls++; throw Object.assign(new Error('insufficient credits'), { status: 402 }); },
    { now: () => now, retryMs: 100, maxRetryMs: 150 });
  t.after(() => instance.close());
  instance.observe(view(request())); await settle();
  assert.equal(calls, 1);
  now = 99; instance.pump(); await settle(); assert.equal(calls, 1);
  now = 100; instance.pump(); await settle(); assert.equal(calls, 2);
  // Capped at maxRetryMs: the next wait is 150, not 200.
  now = 249; instance.pump(); await settle(); assert.equal(calls, 2);
  now = 250; instance.pump(); await settle(); assert.equal(calls, 3);
});

test('the chat-completions provider omits authorization for a configured keyless local endpoint', async () => {
  let sent;
  const provider = chatCompletionsHumanCopyProvider({
    url: 'http://127.0.0.1:1234/v1/chat/completions', apiKey: '', model: 'local-model',
    fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t"}' } }] })); },
  });
  await provider({ version: 1 });
  assert.equal(sent.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(Object.hasOwn(sent.init.headers, 'Authorization'), false);
});

test('the chat-completions provider sends the configured model and key and parses JSON copy', async () => {
  let sent;
  const provider = chatCompletionsHumanCopyProvider({
    url: 'https://example.test/v1/chat/completions', apiKey: 'key-1', model: 'configured-model',
    fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ model: 'configured-model', choices: [{ message: { content: '{"title":"t"}' } }] })); },
  });
  const input = { original: { text: 'Lütfen iş kartlarımı göster.' } };
  const result = await provider(input);
  assert.equal(sent.url, 'https://example.test/v1/chat/completions');
  assert.equal(sent.init.headers.Authorization, 'Bearer key-1');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, 'configured-model');
  assert.ok(body.messages[0].content.includes('First decide which human language the person wrote original.text in, ignoring code, file paths, URLs, repository and product names; write every value in that language. It overrides the language of these instructions and of the rest of the payload.'));
  assert.deepEqual(JSON.parse(body.messages[1].content), input);
  assert.deepEqual(result.output, { title: 't' });
  assert.equal(result.error, null);
});
