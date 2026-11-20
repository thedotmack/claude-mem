import { afterEach, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { sharedReviewDescriptor, readSharedReview, publishSharedReview, getSharedReviews } from '../../../src/services/work-view/shared-reviews.mjs';
import { stableEvidenceRef } from '../../../src/services/work-view/shared-projection.mjs';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache } from '../../../src/utils/redaction.js';
import { publishSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const NOW = 1793491200000;
function replica(deviceId: string) {
  const db = new Database(':memory:');
  const store = new SessionStore(db); store.setLocalSyncDeviceId(deviceId);
  cleanup.push(() => db.close());
  return { db, store, deviceId };
}
function transfer(a: ReturnType<typeof replica>, b: ReturnType<typeof replica>) {
  const apply = new SyncApply(b.db, { deviceId: b.deviceId });
  const rows = a.db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as any[];
  const cursor = BigInt(apply.getCursor());
  apply.applyOps(decodeChanges(rows.map((row, i) => ({ seq: String(cursor + BigInt(i + 1)), ...buildContentOperation({
    kind: 'work_state', originDeviceId: a.deviceId, originLocalId: String(row.id), entityRev: String(row.sync_rev),
    payload: { project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch) },
  }) }))), { epoch: '1' });
}
function request(r: ReturnType<typeof replica>, id: number) {
  return { id: `local-${id}`, explicitRequestId: 'release', projects: ['repo'], title: 'Release', titleSource: 'work-state',
    original: { text: 'Release the viewer', source: 'work-state', sourceId: id, url: `/api/work-view/evidence/work-state/${id}` },
    scopeUpdates: [], agentIds: [], items: [{ id: `task-${id}`, kind: 'work-state', title: 'Ship', status: 'done', sourceRefs: [{ kind: 'work-state', id }] }],
    lifecycle: { explicit: true, complete: true, status: 'done' }, sourceContentHashes: [{ kind: 'work-state', id, hash: `legacy-${id}` }] };
}
function pair() {
  const a = replica('a'), b = replica('b');
  const id = a.store.appendWorkStateEntry({ project: 'repo', listName: 'release', fields: { task: 'Ship', status: 'done', narrative: 'Full recorded evidence' }, createdAtEpoch: NOW });
  b.store.appendWorkStateEntry({ project: 'padding', listName: 'padding', fields: {} });
  transfer(a, b);
  const other = (b.db.query("SELECT id FROM work_state_entries WHERE origin_device_id='a' AND origin_local_id=?").get(String(id)) as any).id;
  return { a, b, id, other, ar: request(a, id), br: request(b, other) };
}

test('real canonical replicas check and uncheck the same full evidence with different row ids', () => {
  const { a, b, id, other, ar, br } = pair();
  expect(other).not.toBe(id);
  const ad = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' });
  const bd = sharedReviewDescriptor(b.db, br, { deviceId: 'b' });
  expect(ad.complete).toBe(true); expect(bd).toEqual(ad);
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: true, expectedHash: null, now: NOW });
  transfer(a, b);
  expect(readSharedReview(getSharedReviews(b.db, 'b'), bd).checked).toBe(true);
  const current = readSharedReview(getSharedReviews(b.db, 'b'), bd);
  publishSharedReview(b.db, { deviceId: 'b', project: 'repo', descriptor: bd, checked: false, expectedHash: current.hash, now: NOW + 1 });
  transfer(b, a);
  expect(readSharedReview(getSharedReviews(a.db, 'a'), ad).checked).toBe(false);
  expect(() => publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: true, expectedHash: null, now: NOW + 2 })).toThrow('changed since read');
});

test('full evidence changes invalidate checking; generated copy, local paths and transport ids do not', () => {
  const { a, ar, id } = pair();
  const before = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' });
  const relocated = { ...ar, items: ar.items.map(item => ({ ...item, path: '/different/computer/result.txt', sourcePath: '/private/source', fileUrl: '/api/work-view/file/local' })) };
  expect(sharedReviewDescriptor(a.db, relocated, { deviceId: 'a' })).toEqual(before);
  const display = { ...ar, id: 'elsewhere', title: 'Generated wording', titleSource: 'human-copy', humanCopy: { title: 'Generated' } };
  const generatedOriginal = { ...ar, title: 'Other generated title', titleSource: 'human-copy' };
  expect(sharedReviewDescriptor(a.db, display, { deviceId: 'a' })).toEqual(sharedReviewDescriptor(a.db, generatedOriginal, { deviceId: 'a' }));
  a.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run(JSON.stringify({ task: 'Ship', status: 'done', narrative: 'Changed beyond the visible title' }), id);
  const changed = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' });
  expect(changed.fingerprint).not.toBe(before.fingerprint);
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: before, checked: true, expectedHash: null, now: NOW });
  expect(readSharedReview(getSharedReviews(a.db, 'a'), changed).checked).toBe(false);
});

test('new full evidence replicates canonically and invalidates a shared check on both peers', () => {
  const { a, b, ar, br } = pair();
  const beforeA = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' });
  const beforeB = sharedReviewDescriptor(b.db, br, { deviceId: 'b' });
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: beforeA, checked: true, expectedHash: null, now: NOW });
  transfer(a, b);
  expect(readSharedReview(getSharedReviews(a.db, 'a'), beforeA).checked).toBe(true);
  expect(readSharedReview(getSharedReviews(b.db, 'b'), beforeB).checked).toBe(true);

  // Append through the normal source writer. Only full evidence changes here;
  // the compact request title, task and explicit completion stay the same.
  const added = a.store.appendWorkStateEntry({ project: 'repo', listName: 'release',
    fields: { task: 'Ship', status: 'done', narrative: 'Additional complete source evidence beyond the compact result' }, createdAtEpoch: NOW + 1 });
  transfer(a, b);
  const received = (b.db.query("SELECT id FROM work_state_entries WHERE origin_device_id='a' AND origin_local_id=?").get(String(added)) as any).id;
  expect(received).not.toBe(added);
  const changedA = sharedReviewDescriptor(a.db, { ...ar, sourceContentHashes: [...ar.sourceContentHashes, { kind: 'work-state', id: added }] }, { deviceId: 'a' });
  const changedB = sharedReviewDescriptor(b.db, { ...br, sourceContentHashes: [...br.sourceContentHashes, { kind: 'work-state', id: received }] }, { deviceId: 'b' });
  expect(changedA.complete).toBe(true);
  expect(changedA.requestId).toBe(beforeA.requestId);
  expect(changedA.fingerprint).not.toBe(beforeA.fingerprint);
  expect(changedB).toEqual(changedA);
  expect(readSharedReview(getSharedReviews(a.db, 'a'), changedA)).toMatchObject({ checked: false, matches: false });
  expect(readSharedReview(getSharedReviews(b.db, 'b'), changedB)).toMatchObject({ checked: false, matches: false });
});

test('arbitrary work-state payload keys named like metadata remain full evidence on both canonical replicas', () => {
  const { a, b, ar, br, id, other } = pair();
  let fields: any = { task: 'Ship', status: 'done', id: 'user-id-1', path: '/semantic/source/one', url: 'file:///semantic/source/one',
    nested: JSON.stringify({ id: 'nested-id-1', path: '/nested/one', url: 'custom:one', sourceId: 7, available: true }) };
  // Canonical corrections must advance entity revision; replaying different
  // bytes under the old revision is intentionally quarantined by SyncApply.
  a.db.query('UPDATE work_state_entries SET fields=?, sync_rev=CAST(sync_rev AS INTEGER)+1 WHERE id=?').run(JSON.stringify(fields), id); transfer(a, b);
  for (const change of [
    { id: 'user-id-2' }, { path: '/semantic/source/two' }, { url: 'file:///semantic/source/two' },
    { nested: JSON.stringify({ id: 'nested-id-2', path: '/nested/two', url: 'custom:two', sourceId: 8, available: false }) },
  ]) {
    const beforeA = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' }), beforeB = sharedReviewDescriptor(b.db, br, { deviceId: 'b' });
    expect(beforeB).toEqual(beforeA);
    const prior = readSharedReview(getSharedReviews(a.db, 'a'), beforeA);
    publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: beforeA, checked: true, expectedHash: prior.hash, now: NOW + 10 });
    transfer(a, b);
    expect(readSharedReview(getSharedReviews(b.db, 'b'), beforeB).checked).toBe(true);
    const revision = (a.db.query('SELECT sync_rev FROM work_state_entries WHERE id=?').get(id) as any).sync_rev;
    fields = { ...fields, ...change };
    a.db.query('UPDATE work_state_entries SET fields=?, sync_rev=CAST(sync_rev AS INTEGER)+1 WHERE id=?').run(JSON.stringify(fields), id);
    expect((a.db.query('SELECT sync_rev FROM work_state_entries WHERE id=?').get(id) as any).sync_rev).not.toBe(revision);
    transfer(a, b);
    expect(JSON.parse((b.db.query('SELECT fields FROM work_state_entries WHERE id=?').get(other) as any).fields)).toEqual(fields);
    const changedA = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' }), changedB = sharedReviewDescriptor(b.db, br, { deviceId: 'b' });
    expect(changedA.fingerprint).not.toBe(beforeA.fingerprint); expect(changedB).toEqual(changedA);
    expect(readSharedReview(getSharedReviews(a.db, 'a'), changedA).checked).toBe(false);
    expect(readSharedReview(getSharedReviews(b.db, 'b'), changedB).checked).toBe(false);
  }
});

test('changed aggregate published URL invalidates both reviews while product lookup metadata does not', () => {
  const { a, b, ar, br } = pair();
  const key = JSON.stringify(['conversation', 'claude', 'public-product']);
  const value = (url: string) => ({ session: { project: 'repo', platform_source: 'claude', content_session_id: 'public-product' },
    attributions: [], launches: [], activity: [], products: [{ kind: 'pull-request', title: 'Release', url, atEpoch: NOW }] });
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', updates: [{ kind: 'provenance', key, value: value('https://github.com/example/repo/pull/1') }] });
  transfer(a, b);
  const withProduct = (r: ReturnType<typeof replica>, request: any) => ({ ...request,
    workProduct: (getSharedReviews(r.db, r.deviceId).records.get(sharedRecordKey('provenance', key))!.value as any).products });
  const beforeA = sharedReviewDescriptor(a.db, withProduct(a, ar), { deviceId: 'a' });
  const beforeB = sharedReviewDescriptor(b.db, withProduct(b, br), { deviceId: 'b' });
  expect(beforeB).toEqual(beforeA);
  const relocated = withProduct(a, ar); relocated.workProduct = relocated.workProduct.map((product: any) => ({ ...product, sourceRef: { kind: 'tool-use', id: 900 }, fileUrl: '/local/lookup', available: false }));
  expect(sharedReviewDescriptor(a.db, relocated, { deviceId: 'a' })).toEqual(beforeA);
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: beforeA, checked: true, expectedHash: null, now: NOW }); transfer(a, b);
  expect(readSharedReview(getSharedReviews(b.db, 'b'), beforeB).checked).toBe(true);
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', updates: [{ kind: 'provenance', key, value: value('https://github.com/example/repo/pull/2') }] }); transfer(a, b);
  const afterA = sharedReviewDescriptor(a.db, withProduct(a, ar), { deviceId: 'a' }), afterB = sharedReviewDescriptor(b.db, withProduct(b, br), { deviceId: 'b' });
  expect(afterA.fingerprint).not.toBe(beforeA.fingerprint); expect(afterB).toEqual(afterA);
  expect(readSharedReview(getSharedReviews(a.db, 'a'), afterA).checked).toBe(false);
  expect(readSharedReview(getSharedReviews(b.db, 'b'), afterB).checked).toBe(false);
});

test('a new losing review head invalidates the old token even when the selected record is unchanged', () => {
  const { a, b, ar, br } = pair();
  const ad = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' }), bd = sharedReviewDescriptor(b.db, br, { deviceId: 'b' });
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: false, expectedHash: null, now: NOW }); transfer(a, b);
  const base = readSharedReview(getSharedReviews(a.db, 'a'), ad).hash;
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: false, expectedHash: base, now: NOW + 1 });
  publishSharedReview(b.db, { deviceId: 'b', project: 'repo', descriptor: bd, checked: true, expectedHash: base, now: NOW + 2 });
  const before = readSharedReview(getSharedReviews(b.db, 'b'), bd);
  transfer(a, b);
  const conflict = readSharedReview(getSharedReviews(b.db, 'b'), bd);
  expect(conflict.recordHash).toBe(before.recordHash); expect(conflict.hash).not.toBe(before.hash);
  expect(conflict).toMatchObject({ checked: false, conflict: true });
  expect(() => publishSharedReview(b.db, { deviceId: 'b', project: 'repo', descriptor: bd, checked: true, expectedHash: before.hash, now: NOW + 3 })).toThrow('changed since read');
  publishSharedReview(b.db, { deviceId: 'b', project: 'repo', descriptor: bd, checked: true, expectedHash: conflict.hash, now: NOW + 4 }); transfer(b, a);
  expect(readSharedReview(getSharedReviews(a.db, 'a'), ad)).toEqual(readSharedReview(getSharedReviews(b.db, 'b'), bd));
  expect(readSharedReview(getSharedReviews(a.db, 'a'), ad)).toMatchObject({ checked: true, conflict: false });
});

test('same-title aggregate git SHA, branch, repository and head changes invalidate across replicas', () => {
  const { a, b, ar, br } = pair();
  const key = JSON.stringify(['conversation', 'claude', 'git-identity']);
  let product: any = { kind: 'branch', title: 'Published work', url: 'https://github.com/example/repo/tree/main',
    sha: 'a'.repeat(40), branch: 'main', repo: 'example/repo', heads: ['a'.repeat(40)] };
  const publish = () => publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', updates: [{ kind: 'provenance', key,
    value: { session: { platform_source: 'claude', content_session_id: 'git-identity' }, attributions: [], launches: [], activity: [], products: [product] } }] });
  const descriptor = (r: ReturnType<typeof replica>, request: any) => sharedReviewDescriptor(r.db, { ...request,
    workProduct: (getSharedReviews(r.db, r.deviceId).records.get(sharedRecordKey('provenance', key))!.value as any).products }, { deviceId: r.deviceId });
  publish(); transfer(a, b);
  for (const change of [{ sha: 'b'.repeat(40) }, { branch: 'release' }, { repo: 'example/next' }, { heads: ['b'.repeat(40)] }]) {
    const before = descriptor(a, ar); expect(descriptor(b, br)).toEqual(before);
    publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: before, checked: true,
      expectedHash: readSharedReview(getSharedReviews(a.db, 'a'), before).hash, now: NOW + 30 }); transfer(a, b);
    product = { ...product, ...change }; publish(); transfer(a, b);
    const after = descriptor(a, ar); expect(after.fingerprint).not.toBe(before.fingerprint); expect(descriptor(b, br)).toEqual(after);
    expect(readSharedReview(getSharedReviews(b.db, 'b'), after).checked).toBe(false);
  }
});

test('offline opposite decisions converge to unchecked conflict until a fresh explicit choice', () => {
  const { a, b, ar, br } = pair();
  const ad = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' }), bd = sharedReviewDescriptor(b.db, br, { deviceId: 'b' });
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: true, expectedHash: null, now: NOW });
  transfer(a, b);
  const base = readSharedReview(getSharedReviews(a.db, 'a'), ad).hash;
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: true, expectedHash: base, now: NOW + 1 });
  publishSharedReview(b.db, { deviceId: 'b', project: 'repo', descriptor: bd, checked: false, expectedHash: base, now: NOW + 2 });
  transfer(a, b); transfer(b, a);
  const result = readSharedReview(getSharedReviews(a.db, 'a'), ad);
  expect(result).toMatchObject({ checked: false, conflict: true, available: true });
  expect(readSharedReview(getSharedReviews(b.db, 'b'), bd)).toEqual(result);
  publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: true, expectedHash: result.hash, now: NOW + 3 });
  transfer(a, b);
  expect(readSharedReview(getSharedReviews(b.db, 'b'), bd)).toMatchObject({ checked: true, conflict: false });
});

test('different source disclosure cannot inherit a check and session stubs cannot establish full evidence', () => {
  const { a, b, ar, br, other } = pair();
  const ad = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' });
  b.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run(JSON.stringify({ task: 'Ship', status: 'done', narrative: '[REDACTED]' }), other);
  expect(sharedReviewDescriptor(b.db, br, { deviceId: 'b' }).fingerprint).not.toBe(ad.fingerprint);
  const session = a.store.createSDKSession('session-only', 'repo', 'Opening prompt', undefined, 'claude');
  const sessionRequest = { ...ar, original: { text: 'Opening prompt', source: 'session-initial-request', sourceId: session }, sourceContentHashes: [{ kind: 'session', id: session }] };
  expect(stableEvidenceRef(a.db, 'session', session, 'a')).not.toBeNull();
  expect(sharedReviewDescriptor(a.db, sessionRequest, { deviceId: 'a' }).complete).toBe(false);
});

test('semantic JSON formatting is stable and missing prompt numbers do not merge distinct requests', () => {
  const { a, b, ar, br, id, other } = pair();
  a.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run('{"task":"Ship","nested":{"one":1,"two":[2,3]},"status":"done"}', id);
  b.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run('{ "status": "done", "nested": {"two": [2, 3], "one": 1}, "task": "Ship" }', other);
  expect(sharedReviewDescriptor(a.db, ar, { deviceId: 'a' })).toEqual(sharedReviewDescriptor(b.db, br, { deviceId: 'b' }));
  const session = a.store.createSDKSession('same', 'repo', 'First request', undefined, 'claude');
  a.store.saveUserPrompt('same', 1, 'First request', session);
  a.store.saveUserPrompt('same', 2, 'Second request', session);
  const prompts = a.db.query('SELECT id FROM user_prompts WHERE session_db_id=? ORDER BY id').all(session) as { id: number }[];
  const ungrouped = { ...ar, explicitRequestId: undefined, conversationKey: '["conversation","claude","same"]',
    original: { source: 'user-prompt', sourceId: prompts[0].id, text: 'First request' } };
  const otherRequest = { ...ungrouped, original: { source: 'user-prompt', sourceId: prompts[1].id, text: 'Second request' } };
  expect(sharedReviewDescriptor(a.db, otherRequest, { deviceId: 'a' }).requestId).not.toBe(sharedReviewDescriptor(a.db, ungrouped, { deviceId: 'a' }).requestId);
});

test('request project paths normalize across replicas while semantic payload project paths remain evidence', () => {
  const { a, b, ar, br, id } = pair();
  const local = { ...ar, projects: ['/Users/origin/repo'] };
  const remote = { ...br, projects: ['/home/replica/repo'] };
  const before = sharedReviewDescriptor(a.db, local, { deviceId: 'a' });
  expect(sharedReviewDescriptor(b.db, remote, { deviceId: 'b' })).toEqual(before);
  expect(sharedReviewDescriptor(a.db, { ...local, projects: ['/Users/origin/repo', 'repo', 'other', 'repo'] }, { deviceId: 'a' }))
    .toEqual(sharedReviewDescriptor(b.db, { ...remote, projects: ['other', 'repo'] }, { deviceId: 'b' }));
  expect(sharedReviewDescriptor(b.db, { ...remote, projects: ['other-project'] }, { deviceId: 'b' }).fingerprint).not.toBe(before.fingerprint);
  const fields = { task: 'Ship', status: 'done', project: '/Users/origin/semantic-evidence' };
  a.db.query('UPDATE work_state_entries SET fields=?, sync_rev=CAST(sync_rev AS INTEGER)+1 WHERE id=?').run(JSON.stringify(fields), id); transfer(a, b);
  const payloadBefore = sharedReviewDescriptor(a.db, local, { deviceId: 'a' });
  expect(sharedReviewDescriptor(b.db, remote, { deviceId: 'b' })).toEqual(payloadBefore);
  a.db.query('UPDATE work_state_entries SET fields=?, sync_rev=CAST(sync_rev AS INTEGER)+1 WHERE id=?')
    .run(JSON.stringify({ ...fields, project: '/home/replica/semantic-evidence' }), id); transfer(a, b);
  const payloadAfter = sharedReviewDescriptor(a.db, local, { deviceId: 'a' });
  expect(payloadAfter.fingerprint).not.toBe(payloadBefore.fingerprint);
  expect(sharedReviewDescriptor(b.db, remote, { deviceId: 'b' })).toEqual(payloadAfter);
});

test.each([
  { narrative: 'SOURCE_SECRET', sameDisclosure: false },
  { narrative: 'Publicly shareable full evidence', sameDisclosure: true },
])('actual differing receiver policy preserves reviews only for equal disclosure: %p', scenario => {
  const settings = spyOn(SettingsDefaultsManager, 'loadFromFile');
  const policy = (enabled: boolean) => {
    settings.mockImplementation(() => ({ ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_REDACT_ENABLED: String(enabled),
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: JSON.stringify([{ name: 'review_secret', regex: 'SOURCE_SECRET' }]) }));
    _resetRedactionConfigCache();
  };
  try {
    policy(false);
    const a = replica('a'), b = replica('b');
    const id = a.store.appendWorkStateEntry({ project: 'repo', listName: 'release', fields: { task: 'Ship', narrative: scenario.narrative } });
    const ar = request(a, id), ad = sharedReviewDescriptor(a.db, ar, { deviceId: 'a' });
    publishSharedReview(a.db, { deviceId: 'a', project: 'repo', descriptor: ad, checked: true, expectedHash: null, now: NOW });
    policy(true); transfer(a, b);
    const other = (b.db.query("SELECT id FROM work_state_entries WHERE origin_device_id='a' AND origin_local_id=?").get(String(id)) as any).id;
    expect((b.db.query('SELECT fields FROM work_state_entries WHERE id=?').get(other) as any).fields).not.toContain('SOURCE_SECRET');
    const bd = sharedReviewDescriptor(b.db, request(b, other), { deviceId: 'b' });
    if (scenario.sameDisclosure) expect(bd).toEqual(ad);
    else expect(bd.fingerprint).not.toBe(ad.fingerprint);
    expect(readSharedReview(getSharedReviews(b.db, 'b'), bd)).toMatchObject({ checked: scenario.sameDisclosure, matches: scenario.sameDisclosure });
  } finally { settings.mockRestore(); _resetRedactionConfigCache(); }
});
