import test from 'node:test';
import assert from 'node:assert/strict';
import { createHumanCopyInput, humanCopyFingerprint, validateHumanCopy, generateHumanCopy, HUMAN_COPY_MAX_CHARS } from '../../../src/services/work-view/human-copy.mjs';

const request = () => ({
  id: 'human-request', title: 'Cached display label', original: { text: 'Show the work I asked for in one live view.', source: 'user-prompt', sourceId: 12 },
  scopeUpdates: [{ text: 'Group the work by agent.', sourceId: 13, atEpoch: 100 }],
  workstreams: [{ id: 'stream-1', title: 'Cached stream wording', items: [{ id: 'task-1', title: 'Connect the read-only work feed', status: 'doing', progress: { text: 'Real entries are visible.' }, nextStep: { text: 'Check mobile layout.' }, outcome: null, sourceRefs: [{ kind: 'work-state', id: 10 }], lastUpdateEpoch: 120 }], activity: [{ kind: 'observation', title: 'Feed update received', detail: 'Observed a new real entry.', sourceRef: { kind: 'observation', id: 20 }, atEpoch: 121 }] }],
});
const valid = () => ({ title: 'See your work live', summary: 'The view now reflects recorded work updates.', next: 'Check the mobile layout.', workstreams: [{ id: 'stream-1', title: 'Connect the live feed', summary: 'Real updates are reaching the view.' }] });

test('input excludes generated labels and retains bounded source refs', () => {
  const input = createHumanCopyInput(request());
  assert.equal(JSON.stringify(input).includes('Cached'), false);
  assert.deepEqual(input.workstreams[0].sourceRefs, [{ kind: 'work-state', id: 10 }]);
  assert.equal(input.workstreams[0].observations.length, 1);
  assert.equal(input.original.sourceRef.id, 12);
});

test('fingerprint ignores heartbeat, age, health, cache labels, and evidence-location-only changes', () => {
  const before = request(), after = structuredClone(before);
  after.generatedAt = 'later'; after.source = { connected: false }; after.updatedAtEpoch = 999;
  after.title = 'New cached wording'; after.workstreams[0].title = 'New cached stream wording';
  after.workstreams[0].items[0].lastUpdateEpoch = 1000;
  after.workstreams[0].activity[0].atEpoch = 1000;
  after.original.sourceId = 999; after.workstreams[0].items[0].sourceRefs[0].id = 777;
  assert.equal(humanCopyFingerprint(createHumanCopyInput(before)), humanCopyFingerprint(createHumanCopyInput(after)));
});

test('meaningful progress, status, scope, and stream identity changes invalidate wording', () => {
  const baseline = humanCopyFingerprint(createHumanCopyInput(request()));
  for (const mutate of [
    (r) => { r.workstreams[0].items[0].status = 'done'; },
    (r) => { r.workstreams[0].items[0].progress.text = 'The mobile check failed.'; },
    (r) => { r.scopeUpdates[0].text = 'Group by human request.'; },
    (r) => { r.workstreams[0].id = 'stream-new'; },
  ]) {
    const changed = request(); mutate(changed);
    assert.notEqual(humanCopyFingerprint(createHumanCopyInput(changed)), baseline);
  }
});

test('large source inputs stay within budget while retaining every workstream identity', () => {
  const large = request();
  large.original.text = 'Original request. '.repeat(1000);
  large.scopeUpdates = Array.from({ length: 12 }, (_, i) => ({ text: `Scope ${i} `.repeat(500), sourceId: i }));
  large.workstreams = Array.from({ length: 30 }, (_, i) => ({
    id: `stream-${i}`, items: Array.from({ length: 15 }, () => ({ ...request().workstreams[0].items[0], title: 'Task '.repeat(300), progress: { text: 'Progress '.repeat(300) }, outcome: { text: 'Outcome '.repeat(300) } })),
    activity: Array.from({ length: 10 }, () => ({ kind: 'observation', title: 'Observation '.repeat(300), detail: 'Detail '.repeat(300) })),
  }));
  const input = createHumanCopyInput(large);
  assert.ok(JSON.stringify(input).length <= HUMAN_COPY_MAX_CHARS);
  assert.equal(input.workstreams.length, 30);
  assert.ok(input.workstreams.every((stream) => stream.currentItems.length <= 8 && stream.observations.length <= 3));
});

test('validator rejects invented/missing/duplicate identities, status fields, and oversized copy', () => {
  const input = createHumanCopyInput(request());
  assert.deepEqual(validateHumanCopy(valid(), input), valid());
  for (const output of [
    { ...valid(), workstreams: [{ ...valid().workstreams[0], id: 'invented' }] },
    { ...valid(), workstreams: [] },
    { ...valid(), status: 'done' },
    { ...valid(), title: 'x'.repeat(101) },
    { ...valid(), workstreams: [{ ...valid().workstreams[0], status: 'done' }] },
  ]) assert.throws(() => validateHumanCopy(output, input));
  const two = { ...input, workstreams: [...input.workstreams, { id: 'stream-2' }] };
  assert.throws(() => validateHumanCopy({ ...valid(), workstreams: [valid().workstreams[0], valid().workstreams[0]] }, two), /duplicate/);
});

test('provider injection validates one response for the whole request without network or credentials', async () => {
  let calls = 0;
  const result = await generateHumanCopy(request(), async (input) => { calls++; assert.equal(input.workstreams.length, 1); return JSON.stringify(valid()); });
  assert.equal(calls, 1);
  assert.equal(result.copy.title, valid().title);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});
