import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SharedWorkSync } from '../../../src/services/work-view/SharedWorkSync.js';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';
import { getSharedReviews, sharedSuggestionDescriptor } from '../../../src/services/work-view/shared-reviews.mjs';
import { groupIdFor, readLedger } from '../../../src/services/work-view/request-groups.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';

const cleanup: (() => unknown)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const key = (id: string) => JSON.stringify(['conversation', 'claude', id]);
const T = key('target'), C = key('candidate'), C2 = key('candidate-child'), U = key('unrelated');
const targetId = groupIdFor(T), ownId = groupIdFor(C), unrelatedId = groupIdFor(U);
function fixture(deviceId: string) {
  const directory = mkdtempSync(join(tmpdir(), 'suggestion-resolution-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'memory.db'), ledger = join(directory, 'work'); mkdirSync(ledger);
  const store = new SessionStore(path); store.setLocalSyncDeviceId(deviceId); cleanup.push(() => store.close());
  const sync = new SharedWorkSync(store.db, { databasePath: path, directory: ledger, deviceId, enabled: true, notify() {} }); cleanup.push(() => sync.close());
  const source = new WorkStateSource({ databasePath: path, ledgerDir: ledger, localDeviceId: deviceId }); cleanup.push(() => source.close());
  return { store, sync, source, deviceId, ledger };
}
function transfer(a: ReturnType<typeof fixture>, b: ReturnType<typeof fixture>) {
  const apply = new SyncApply(b.store.db, { deviceId: b.deviceId });
  const cursor = BigInt(apply.getCursor());
  const rows = a.store.db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as any[];
  apply.applyOps(decodeChanges(rows.map((row, index) => ({ seq: String(cursor + BigInt(index + 1)), ...buildContentOperation({
    kind: 'work_state', originDeviceId: a.deviceId, originLocalId: String(row.id), entityRev: String(row.sync_rev),
    payload: { project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch) },
  }) }))), { epoch: '1' });
}
const shared = (f: ReturnType<typeof fixture>) => getSharedReviews(f.store.db, f.deviceId);
const record = (f: ReturnType<typeof fixture>, id: string) => shared(f).records.get(sharedRecordKey('group', id))!;

test.each(['join', 'not-this'] as const)('fresh %s resolves opposite offline decisions without touching an unrelated conflict', async action => {
  const a = fixture('z-join-winner'), b = fixture('a-decline-loser');
  const groups = { version: 1, updatedAt: null, groups: {
    [targetId]: { title: 'Target request', anchor: T, links: [] },
    [ownId]: { title: 'Original candidate request', anchor: C, links: [{ kind: 'judge', conversations: [C, C2], evidence: 'Original candidate continuation' }] },
    [unrelatedId]: { title: 'Unrelated request', anchor: U, links: [] },
  }, conversations: { [T]: targetId, [C]: ownId, [C2]: ownId, [U]: unrelatedId }, ignored: {},
  suggestions: { [C]: { requestId: targetId, status: 'open', confidence: .7, evidence: 'Candidate looks related' } } };
  a.sync.saveFile('request-groups.json', groups); transfer(a, b); await b.sync.prepareOwnerAction();
  const before = sharedSuggestionDescriptor(shared(a), C).hash;
  expect(sharedSuggestionDescriptor(shared(b), C).hash).toBe(before);
  a.sync.answerSuggestion(C, 'join', before);
  b.sync.answerSuggestion(C, 'not-this', before);
  const aGroups = readLedger(a.ledger).groups, bGroups = readLedger(b.ledger).groups;
  aGroups.groups[unrelatedId].title = 'Unrelated A'; bGroups.groups[unrelatedId].title = 'Unrelated B';
  a.sync.saveFile('request-groups.json', aGroups); b.sync.saveFile('request-groups.json', bGroups);
  for (const [name, text] of [['target', 'Build the target'], ['candidate', 'Build the candidate'], ['candidate-child', 'Continue the candidate'], ['unrelated', 'Unrelated task']]) {
    const id = a.store.createSDKSession(name, 'repo', text, undefined, 'claude');
    a.store.saveUserPrompt(name, 1, text, id);
  }
  const winnerHash = record(a, targetId).hash, revisionBeforeLoser = shared(a).revision;
  const viewBefore = a.source.read({ maxActivityAgeMs: 120_000 }).agentView;
  expect(a.source.read({ maxActivityAgeMs: 120_000 }).agentView.revision).toBe(viewBefore.revision);
  transfer(b, a); // The lower-lexical head arrives after the displayed winner.
  expect(record(a, targetId).hash).toBe(winnerHash);
  expect(shared(a).revision).not.toBe(revisionBeforeLoser);
  const afterLoser = a.source.read({ maxActivityAgeMs: 120_000 }).agentView;
  expect(afterLoser.revision).not.toBe(viewBefore.revision);
  expect(a.source.read({ maxActivityAgeMs: 120_000 }).agentView.revision).toBe(afterLoser.revision);
  expect(afterLoser.suggestions?.find((suggestion: any) => suggestion.conversationKey === C)).toMatchObject({ sharedConflict: true });
  const candidateCard = afterLoser.humanRequests.find((request: any) => request.conversationKeys.includes(C));
  expect(candidateCard?.suggestion).toMatchObject({ sharedConflict: true, conversationKey: C, expectedSuggestionHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  transfer(a, b);
  const fresh = sharedSuggestionDescriptor(shared(a), C);
  expect(fresh).toMatchObject({ conflict: true });
  expect(fresh.hash).not.toBe(before);
  expect(() => a.sync.answerSuggestion(C, action, before)).toThrow('changed since read');
  const unrelatedBefore = record(a, unrelatedId).hash;
  await a.sync.prepareOwnerAction();
  const baseline = readLedger(a.ledger).groups, outsideScope = structuredClone(baseline);
  outsideScope.groups[unrelatedId].title = 'Unrelated edit cannot hide in resolution';
  const fileBefore = readFileSync(join(a.ledger, 'request-groups.json'), 'utf8');
  const adapter = new SharedLedgerAdapter(a.store.db, { directory: a.ledger, deviceId: a.deviceId });
  expect(() => adapter.saveFile('request-groups.json', outsideScope, { resolveKeys: fresh.groupKeys, resolutionBaseline: baseline })).toThrow('unrelated group');
  expect(readFileSync(join(a.ledger, 'request-groups.json'), 'utf8')).toBe(fileBefore);
  expect(record(a, unrelatedId).hash).toBe(unrelatedBefore);
  expect(a.sync.answerSuggestion(C, action, fresh.hash)).toMatchObject({ status: action === 'join' ? 'joined' : 'declined' });
  expect(record(a, unrelatedId).hash).toBe(unrelatedBefore);
  expect(shared(a).diagnostics.conflicts.map(conflict => conflict.key)).toEqual([unrelatedId]);
  const target = record(a, targetId), own = record(a, ownId);
  expect(BigInt(target.revision)).toBeGreaterThan(2n);
  if (action === 'not-this') {
    expect((target.value as any).members).toEqual([T]);
    expect(own.deleted).toBe(false);
    expect(new Set((own.value as any).members)).toEqual(new Set([C, C2]));
    expect((own.value as any).group).toMatchObject({ title: 'Original candidate request', links: groups.groups[ownId].links });
  } else {
    expect(new Set((target.value as any).members)).toEqual(new Set([T, C, C2]));
    expect(own.deleted).toBe(true);
  }
  transfer(a, b);
  expect(record(b, targetId)).toEqual(target); expect(record(b, ownId)).toEqual(own);
  expect(sharedSuggestionDescriptor(shared(b), C).hash).toBeNull();
  expect(() => b.sync.answerSuggestion(C, action, fresh.hash)).toThrow('changed since read');
});
