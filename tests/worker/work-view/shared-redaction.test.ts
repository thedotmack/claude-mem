import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { removeTempDir } from '../../helpers/temp-dir.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache, redactJsonStrings } from '../../../src/utils/redaction.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { buildContentOperation, canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { createSharedRecordReader, publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { createSharedBatch, createSharedEntry, sharedEntryRef, sharedRecordKey, sharedValueHash } from '../../../src/services/work-view/shared-records.mjs';
import { isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';
import { foldCloudBatch } from '../../../src/services/work-view/cloud-renderer.js';
import { prepareReviewStackWrite, renderReviewStack, reviewStackPage, ReviewStackError } from '../../../src/services/work-view/review-stack.js';
import { randomUUID } from 'node:crypto';
import { redactSharedValue } from '../../../src/services/work-view/shared-redaction.mjs';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';

const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const cleanup: Array<() => void> = [];
let settings: ReturnType<typeof spyOn> | null = null;
afterEach(async () => {
  settings?.mockRestore(); settings = null; _resetRedactionConfigCache();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function policy(enabled: boolean, custom: string[] = []) {
  settings?.mockRestore();
  settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_REDACT_ENABLED: String(enabled),
    CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: JSON.stringify(custom.map((regex, index) => ({ name: `custom${index}`, regex }))),
  }));
  _resetRedactionConfigCache();
}
function fixture(deviceId: string, path = ':memory:') {
  const db = new Database(path); const store = new SessionStore(db); store.setLocalSyncDeviceId(deviceId);
  cleanup.push(() => db.close());
  return { db, deviceId };
}
type Fixture = ReturnType<typeof fixture>;
const read = (f: Fixture) => readSharedRecords(f.db, { deviceId: f.deviceId, validateValue: isSharedProjectionValue });
const rows = (f: Fixture) => f.db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as any[];
function wires(f: Fixture, input = rows(f)) {
  return input.map(row => buildContentOperation({ kind: 'work_state', originDeviceId: f.deviceId, originLocalId: String(row.id), entityRev: row.sync_rev, payload: {
    project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch),
  } }));
}
function apply(f: Fixture, operations: ReturnType<typeof wires>, first = 1) {
  return new SyncApply(f.db, { deviceId: f.deviceId }).applyOps(decodeChanges(operations.map((wire, index) => ({ ...wire, seq: String(first + index) }))));
}
function story(f: Fixture, narrative: string) {
  return publishSharedRecords(f.db, { deviceId: f.deviceId, project: 'repo', updates: [{ kind: 'story', key: 'current', value: { narrative, preferences: [] } }], validateValue: isSharedProjectionValue });
}
function serializedDatabase(f: Fixture) {
  const tables = f.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  return tables.map(({ name }) => JSON.stringify(f.db.query(`SELECT * FROM "${name}"`).all())).join('\n');
}

test('review excerpts and 5-word titles honor source and recipient redaction before persistence', () => {
  const a = fixture('a'), b = fixture('b'), c = fixture('c');
  const prefix = 'x'.repeat(3990) + ' ';
  const excerpt = prefix + AWS + ' ' + 'z'.repeat(15_978 - prefix.length);
  const body = { cards: [{
    key: 'design-file', title: 'Review this private design ' + AWS, focus: 'Design',
    what: 'The new cover brings the original print design into view.',
    context: 'We are reviewing each draft ahead of the final publication.',
    excerpt,
  }] };
  const importCard = (device: Fixture) => {
    const {updates} = prepareReviewStackWrite([], 'import', body, '86837e86-e937-4b4b-ae8a-0670a697a0be', 1, {redactText:redactSharedValue});
    expect(updates.filter(u => u.key.includes(':excerpt:'))).toHaveLength(1);
    publishSharedRecords(device.db, { deviceId:device.deviceId, project:'Review', updates, validateValue:isSharedProjectionValue });
  };
  policy(false); importCard(a); const wire = wires(a);
  policy(true); importCard(c);
  expect(apply(b, wire).quarantined).toBe(0);
  for (const recipient of [b, c]) {
    const state = read(recipient);
    expect(state.diagnostics.invalid).toBe(0);
    const view = renderReviewStack(state.records.values(), {redactText:redactSharedValue});
    expect(view.cards[0].excerpt).toBe(excerpt.replace(AWS, "<redacted type='aws_access_key'/>"));
    expect(view.cards[0].title).toBe("Review this private design <redacted type='aws_access_key'/>");
    expect(serializedDatabase(recipient)).not.toContain(AWS);
  }
});

test('an enabled policy projects existing synced notes and selects a visible focus across devices', () => {
  const a = fixture('a'), b = fixture('b');
  const write = (f: Fixture, operation: 'import' | 'action', input: unknown) => {
    const prepared = prepareReviewStackWrite(read(f).records.values(), operation, input, randomUUID(), 100, { redactText:redactSharedValue });
    publishSharedRecords(f.db, { deviceId:f.deviceId, project:'Review', updates:prepared.updates, validateValue:isSharedProjectionValue });
  };
  policy(false);
  write(a, 'import', {cards:['TEAM_BLUE', 'TEAM_GREEN'].map(focus => ({
    key:'art-' + focus, focus, title:'Review the artwork',
    what:'The first draft shows original cover artwork for our magazine.',
    context:'We review the cover illustrations together ahead of final publication.',
    source:'https://example.org/' + focus,
  }))});
  const original = renderReviewStack(read(a).records.values());
  write(a, 'action', { action:'follow-up', cardId:original.cards[0].id, body:'Keep FOLLOWUP_PRIVATE visible only when authorized.' });
  expect(apply(b, wires(a)).quarantined).toBe(0);
  const cloud = foldCloudBatch(rows(a).map(row => ({...row, origin_device_id:'a', origin_local_id:String(row.id)})));
  expect(cloud.invalid).toBe(0);
  const plain = renderReviewStack(cloud.members);
  policy(true, ['FOLLOWUP_PRIVATE']);
  const notesMasked = renderReviewStack(cloud.members, {redactText:redactSharedValue});
  expect(notesMasked.cards).toEqual(plain.cards);
  expect(notesMasked.followUps[0].body).toContain("<redacted type='custom0'/>");
  expect(notesMasked.revision).not.toBe(plain.revision);
  expect(() => reviewStackPage(notesMasked, plain.revision + '.1')).toThrow(ReviewStackError);
  policy(true, ['TEAM_BLUE|TEAM_GREEN', 'FOLLOWUP_PRIVATE']);
  const safe = renderReviewStack(read(b).records.values(), {redactText:redactSharedValue});
  expect(renderReviewStack(cloud.members, {redactText:redactSharedValue})).toEqual(safe);
  for (const card of safe.cards) {
    expect(card.key).toBe(card.id);
    expect(card.source).toBeUndefined();
    expect(card.focus).toBe("<redacted type='custom0'/>");
  }
  expect(new Set(safe.cards.map(card => card.focusId)).size).toBe(2);
  expect(() => write(b, 'action', { action:'seen-group', focus:safe.cards[0].focus })).toThrow(ReviewStackError);
  write(b, 'action', { action:'seen-group', focus:safe.cards[0].focus, cardId:safe.cards[0].id });
  const maskedGroup = renderReviewStack(read(b).records.values(), {redactText:redactSharedValue});
  expect(maskedGroup.groups[0]).toMatchObject({activeCount:1,focusId:safe.cards[0].focusId});
  expect(maskedGroup.reviews.map(review => review.cardId)).toEqual([safe.cards[0].id]);
  policy(false);
  expect(apply(a, wires(b)).quarantined).toBe(0);
  const received = renderReviewStack(read(a).records.values());
  expect(received.cards.map(card => card.focus).sort()).toEqual(['TEAM_BLUE','TEAM_GREEN']);
  expect(received.reviews).toEqual(maskedGroup.reviews);
  write(a, 'action', { action:'undo-group', groupId:received.groups[0].id });
  expect(renderReviewStack(read(a).records.values()).reviews).toEqual([]);
});

test('a stricter receiving device keeps two masked scopes distinct and undo leaves the other group seen', () => {
  const a = fixture('alpha'), b = fixture('beta');
  const write = (f: Fixture, operation: 'import' | 'action', body: unknown, mutationId = randomUUID()) => {
    const { updates } = prepareReviewStackWrite(read(f).records.values(), operation, body, mutationId, 1, {redactText:redactSharedValue});
    publishSharedRecords(f.db, {deviceId:f.deviceId,project:'Review',updates,validateValue:isSharedProjectionValue});
    return mutationId;
  };
  policy(false);
  write(a, 'import', {cards:['PRIVATE_ONE','PRIVATE_TWO'].map((focus,i) => ({
    key:'art-' + i, focus, title:'Review the artwork', excerpt:'Original artwork',
    what:'The first draft shows the original artwork for our magazine.',
    context:'We review the magazine covers together ahead of final publication.',
  }))});
  const original = renderReviewStack(read(a).records.values());
  const first = original.cards[0], second = original.cards[1];
  const oldGroupId = write(a, 'action', {action:'seen-group', focus:first.focus});
  policy(true, ['PRIVATE_ONE|PRIVATE_TWO']);
  expect(apply(b, wires(a)).quarantined).toBe(0);
  const received = renderReviewStack(read(b).records.values(), {redactText:redactSharedValue});
  expect(received.cards.map(c => c.focus)).toEqual(["<redacted type='custom0'/>","<redacted type='custom0'/>"]);
  expect(received.cards.map(c => c.focusId)).toEqual(original.cards.map(c => c.focusId));
  expect(received.groups[0]).toMatchObject({id:oldGroupId,count:1,focusId:first.focusId});
  const nextGroupId = write(b, 'action', {action:'seen-group',focus:received.cards[1].focus,cardId:second.id});
  write(b, 'action', {action:'undo-group',groupId:oldGroupId});
  const restored = renderReviewStack(read(b).records.values(), {redactText:redactSharedValue});
  expect(restored.reviews.map(review => review.cardId)).toEqual([second.id]);
  expect(restored.groups).toMatchObject([{id:nextGroupId,count:1,focusId:second.focusId}]);
});

test('receiver redaction preserves a verified link-only card and its unaffected batch sibling', () => {
  const a = fixture('author'), b = fixture('receiver');
  policy(false);
  const cards = ['PRIVATE_KEY','unaffected'].map((key, i) => ({
    key, focus:i ? 'Design' : 'PRIVATE_FOCUS', title:'Review the artwork',
    what:'The first draft shows original cover artwork for our magazine.',
    context:'We review the cover illustrations together ahead of final publication.',
    source:i ? 'https://example.org/safe' : 'https://example.org/PRIVATE_URL',
    ...(i ? {} : {preview:'https://preview.example.org/PRIVATE_URL'}),
  }));
  const {updates} = prepareReviewStackWrite([], 'import', {cards}, randomUUID(), 5);
  publishSharedRecords(a.db, {deviceId:a.deviceId,project:'Review',updates,validateValue:isSharedProjectionValue});
  const plain = renderReviewStack(read(a).records.values());
  const protectedCard = plain.cards.find(c => c.key === 'PRIVATE_KEY')!;
  policy(true, ['PRIVATE_(KEY|URL|FOCUS)']);
  expect(apply(b, wires(a)).quarantined).toBe(0);
  const state = read(b);
  expect(state.diagnostics).toMatchObject({invalid:0,pending:0});
  const safe = renderReviewStack(state.records.values());
  expect(safe.cards).toHaveLength(2);
  const masked = safe.cards.find(c => c.id === protectedCard.id)!;
  expect(masked).toMatchObject({key:protectedCard.id,focusId:protectedCard.focusId});
  expect(masked.source).toBeUndefined();
  expect(masked.preview).toBeUndefined();
  expect(safe.cards.find(c => c.key === 'unaffected')?.source).toBe(cards[1].source);
  expect(serializedDatabase(b)).not.toMatch(/PRIVATE_(KEY|URL|FOCUS)/);
  policy(false);
  expect(renderReviewStack(read(b).records.values())).toEqual(safe);
  const safeHead = state.records.get(sharedRecordKey('stack-card', protectedCard.id))!;
  expect(safeHead.hash).toBe(read(a).records.get(sharedRecordKey('stack-card',protectedCard.id))!.hash);
  expect(safeHead.valueHash).not.toBe(safeHead.hash);
  // A network sender cannot manufacture receiver-only evidence by copying safe fields.
  expect(isSharedProjectionValue('stack-card', protectedCard.id, JSON.parse(JSON.stringify(safeHead.value)))).toBe(false);
});

test('a legacy card receipt recovers on authenticated same-revision replay without restoring any protected value', () => {
  const a = fixture('author'), b = fixture('receiver');
  policy(false);
  const cards = ['PRIVATE_KEY','unaffected'].map(key => ({
    key, focus:'Art', title:'Review the artwork',
    what:'The first draft shows original cover artwork for our magazine.',
    context:'We review the cover illustrations together ahead of final publication.',
    source:'https://example.org/PRIVATE_URL', excerpt:'Original',
  }));
  const {updates} = prepareReviewStackWrite([], 'import', {cards}, randomUUID(), 5);
  publishSharedRecords(a.db,{deviceId:a.deviceId,project:'Review',updates,validateValue:isSharedProjectionValue});
  const operations = wires(a);
  policy(true, ['PRIVATE_(KEY|URL)']);
  expect(apply(b, operations).quarantined).toBe(0);
  for (const row of rows(a)) {
    const fields = JSON.parse(row.fields);
    if (fields.kind !== 'stack-card') continue;
    // Recreate the exact old generic receipt and its attested scrubbed fields.
    const legacyFields = {...fields, payload:canonicalJson(redactSharedValue(JSON.parse(fields.payload)))};
    const stored = canonicalJson(legacyFields);
    const target = b.db.query('SELECT id FROM work_state_entries WHERE origin_device_id=? AND origin_local_id=?')
      .get(a.deviceId,String(row.id)) as {id:number};
    b.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run(stored,target.id);
    b.db.query('UPDATE local_shared_work_redactions SET stored_fields_hash=?,original_ref_json=? WHERE row_id=?')
      .run(sha256Base64Url(stored),canonicalJson(sharedEntryRef(fields)),target.id);
  }
  const reader = createSharedRecordReader(b.db,{deviceId:b.deviceId,validateValue:isSharedProjectionValue});
  expect(reader().diagnostics.invalid).toBe(1);
  policy(false);
  const recovered = apply(b,operations,operations.length + 1);
  expect(recovered.quarantined).toBe(0);
  expect(recovered.applied).toBe(2);
  const reopened = reader(); // unchanged entity revisions must still invalidate the previously cached rejection
  expect(reopened.diagnostics).toMatchObject({invalid:0,pending:0});
  const deck = renderReviewStack(reopened.records.values());
  expect(deck.cards).toHaveLength(2);
  expect(deck.cards.filter(c => c.key === c.id)).toHaveLength(1);
  expect(deck.cards.every(c => c.source === undefined)).toBe(true);
  expect(serializedDatabase(b)).not.toMatch(/PRIVATE_(KEY|URL)/);
  expect(apply(b,operations,2 * operations.length + 1).applied).toBe(0);
});

test.each(['wrong-key','opaque-key','invalid-url'])('rejects the original %s before recipient redaction can mask the defect', flaw => {
  const a = fixture('author'), b = fixture('receiver');
  policy(false);
  const cards = ['original','sibling'].map(key => ({
    key,focus:'Art',title:'Review the artwork',source:'https://example.org/original',
    what:'The first draft shows original cover artwork for our magazine.',
    context:'We review the cover illustrations together ahead of final publication.',
  }));
  const prepared = prepareReviewStackWrite([], 'import', {cards}, randomUUID(), 10);
  const id = randomUUID(), author = a.deviceId;
  const entries = prepared.updates.map(({kind,key,value}, i) => {
    const bad = flaw === 'invalid-url' ? {source:'javascript:PRIVATE_TOKEN'} : {key:flaw === 'opaque-key' ? key : 'PRIVATE_TOKEN'};
    return createSharedEntry({kind,key,value:i === 0 ? {...value as object,...bad} : value,writer:author,batchId:id,revision:'1'});
  });
  const insert = a.db.query('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES(?,?,?,?,?)');
  for (const row of createSharedBatch(entries,{batchId:id,writer:author})) insert.run('Review',row.listName,canonicalJson(row.fields),'2026-11-01T00:00:00Z',1793491200000);
  const cloud = foldCloudBatch(rows(a).map(row => ({...row,origin_device_id:author,origin_local_id:String(row.id)})));
  expect(cloud.invalid).toBe(1);
  expect(cloud.members).toEqual([]);
  policy(true,['PRIVATE_TOKEN']);
  expect(apply(b, wires(a)).quarantined).toBe(1);
  expect(renderReviewStack(read(b).records.values()).cards).toEqual([]);
  expect(serializedDatabase(b)).not.toContain('PRIVATE_TOKEN');
});

test('origin redaction precedes payload and manifest hashes', () => {
  policy(true);
  const a = fixture('a'), b = fixture('b'); story(a, `origin ${AWS}`);
  expect(serializedDatabase(a)).not.toContain(AWS);
  expect(read(a).records.get(sharedRecordKey('story', 'current'))?.value).toMatchObject({ narrative: "origin <redacted type='aws_access_key'/>" });
  expect(apply(b, wires(a))).toMatchObject({ applied: 3, cursor: '3', quarantined: 0 });
  expect(read(b).records).toEqual(read(a).records);
  expect(read(b).diagnostics).toMatchObject({ pending: 0, invalid: 0 });
});

test('origin identity metadata that needs redaction is refused before any canonical row is written', () => {
  policy(true, ['PRIVATE_ID']); const a = fixture('a');
  for (const input of [
    { deviceId: 'PRIVATE_ID', project: 'repo', kind: 'story', key: 'current' },
    { deviceId: 'a', project: 'PRIVATE_ID', kind: 'story', key: 'current' },
    { deviceId: 'a', project: 'repo', kind: 'story', key: 'PRIVATE_ID' },
  ]) expect(() => publishSharedRecords(a.db, { deviceId: input.deviceId, project: input.project, updates: [{ kind: input.kind, key: input.key, value: { narrative: 'Safe content', preferences: [] } }] })).toThrow('identity');
  expect(a.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 0 });
});

test('stricter recipient redaction verifies the original before storing private-safe content and receipts', () => {
  policy(false); const a = fixture('a'), b = fixture('b'); story(a, `recipient ${AWS} PRIVATE_WORD`);
  const wire = wires(a); policy(true, ['PRIVATE_WORD']);
  expect(apply(b, [...wire].reverse())).toMatchObject({ applied: 3, cursor: '3', quarantined: 0 });
  const state = read(b), received = state.records.get(sharedRecordKey('story', 'current'))!;
  expect(state.diagnostics).toMatchObject({ pending: 0, invalid: 0 });
  expect(received.value).toMatchObject({ narrative: "recipient <redacted type='aws_access_key'/> <redacted type='custom0'/>" });
  expect(received.hash).toBe(read(a).records.get(sharedRecordKey('story', 'current'))!.hash);
  expect(received.valueHash).not.toBe(received.hash);
  expect(serializedDatabase(b)).not.toContain(AWS);
  expect(serializedDatabase(b)).not.toContain('PRIVATE_WORD');
  const receipt = b.db.query('SELECT * FROM local_shared_work_redactions').get() as any;
  expect(Object.keys(receipt).sort()).toEqual(['origin_device_id', 'origin_local_id', 'original_ref_json', 'row_id', 'stored_fields_hash', 'sync_rev']);
  const count = b.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get();
  expect(publishSharedRecords(b.db, { deviceId: b.deviceId, project: 'repo', updates: [{ kind: 'story', key: 'current', value: received.value, expectedHash: received.hash }], validateValue: isSharedProjectionValue }).changed).toBe(0);
  expect(b.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual(count);
});

test('origin and recipient custom policies keep the same verified identity with locally stricter display', () => {
  policy(true, ['ORIGIN_WORD']); const a = fixture('a'), b = fixture('b'); story(a, 'ORIGIN_WORD RECEIVER_WORD');
  expect(serializedDatabase(a)).not.toContain('ORIGIN_WORD');
  const sourceHash = read(a).records.get(sharedRecordKey('story', 'current'))!.hash;
  policy(true, ['RECEIVER_WORD']); apply(b, wires(a));
  expect(serializedDatabase(b)).not.toContain('ORIGIN_WORD'); expect(serializedDatabase(b)).not.toContain('RECEIVER_WORD');
  expect(read(b).records.get(sharedRecordKey('story', 'current'))!.hash).toBe(sourceHash);
  expect(read(b).diagnostics.invalid).toBe(0);
});

test('redacted complete state survives restart and remains previous state until every later batch member arrives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-redaction-')); cleanup.push(() => removeTempDir(dir));
  policy(false); const a = fixture('a'), b = fixture('b', join(dir, 'state.db')); story(a, `first ${AWS}`); const first = wires(a);
  policy(true); apply(b, first); const revision = read(b).revision;
  const reader = new Database(join(dir, 'state.db'), { readonly: true });
  try { expect(readSharedRecords(reader, { deviceId: 'b', validateValue: isSharedProjectionValue }).revision).toBe(revision); } finally { reader.close(); }
  policy(false); story(a, `second ${AWS}`); const next = wires(a, rows(a).slice(3)); policy(true);
  apply(b, [next[2]], 4);
  expect(read(b).revision).toBe(revision); expect(read(b).diagnostics.pending).toBe(1);
  apply(b, next.slice(0, 2), 5);
  expect(read(b).records.get(sharedRecordKey('story', 'current'))!.value).toMatchObject({ narrative: "second <redacted type='aws_access_key'/>" });
  expect(read(b).diagnostics).toMatchObject({ pending: 0, invalid: 0 });
});

test('a receipt never blesses modified sanitized fields or a changed origin binding', () => {
  policy(false); const a = fixture('a'), b = fixture('b'); story(a, `private ${AWS}`); policy(true); apply(b, wires(a));
  const row = b.db.query("SELECT * FROM work_state_entries WHERE list_name='__my_work_v1:entry'").get() as any;
  const fields = JSON.parse(row.fields); fields.payload = canonicalJson({ narrative: 'tampered', preferences: [] });
  b.db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run(canonicalJson(fields), row.id);
  expect(read(b).records.size).toBe(0); expect(read(b).diagnostics.invalid).toBe(1);
  b.db.query('UPDATE work_state_entries SET fields=?, sync_rev=? WHERE id=?').run(row.fields, '2', row.id);
  expect(read(b).records.size).toBe(0); expect(read(b).diagnostics.invalid).toBe(1);
});

test('an original hash mismatch cannot become valid merely because redaction would match its forged hash', () => {
  policy(false); const a = fixture('a'), b = fixture('b');
  const value = { narrative: `forged ${AWS}`, preferences: [] };
  const entry = createSharedEntry({ writer: 'a', batchId: 'forged', kind: 'story', key: 'current', revision: '1', value });
  entry.hash = sharedValueHash('story', 'current', redactJsonStrings(value, { enabled: true }));
  const insert = a.db.query('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES(?,?,?,?,?)');
  for (const row of createSharedBatch([entry], { writer: 'a', batchId: 'forged' })) insert.run('repo', row.listName, canonicalJson(row.fields), '2026-11-01T00:00:00Z', 1793491200000);
  policy(true); const result = apply(b, wires(a));
  expect(result.quarantined).toBe(1); expect(read(b).records.size).toBe(0);
  expect(serializedDatabase(b)).not.toContain(AWS);
});

test('receipt persistence failure rolls back the transformed entry and retains previous complete state', () => {
  policy(false); const a = fixture('a'), b = fixture('b'); story(a, `first ${AWS}`); policy(true); apply(b, wires(a));
  const previous = read(b).revision;
  b.db.exec("CREATE TRIGGER reject_redaction_receipt BEFORE INSERT ON local_shared_work_redactions BEGIN SELECT RAISE(ABORT, 'receipt blocked'); END");
  policy(false); story(a, `second ${AWS}`); const next = wires(a, rows(a).slice(3)); policy(true);
  expect(apply(b, next, 4).quarantined).toBe(1);
  expect(read(b).revision).toBe(previous);
  expect(read(b).diagnostics.pending).toBe(1);
  expect(b.db.query('SELECT COUNT(*) AS n FROM local_shared_work_redactions').get()).toEqual({ n: 1 });
  expect(serializedDatabase(b)).not.toContain(AWS);
});

test('the rules-only reader binds redaction receipts without needing a local story file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-redaction-rules-')); cleanup.push(() => removeTempDir(dir));
  policy(false); const a = fixture('a'), b = fixture('b', join(dir, 'state.db'));
  publishSharedRecords(a.db, { deviceId: 'a', project: 'repo', validateValue: isSharedProjectionValue, updates: [{ kind: 'story', key: 'current', value: { preferences: [{ preference: `Avoid ${AWS}`, kind: 'directive', quotes: [{ quote: 'Keep private data private.' }] }] } }] });
  policy(true); apply(b, wires(a));
  const source = new WorkStateSource({ databasePath: join(dir, 'state.db'), ledgerDir: join(dir, 'work-view'), localDeviceId: 'b' });
  try { const result = source.readRules(); expect(result.source.connected).toBe(true); expect(JSON.stringify(result)).not.toContain(AWS); expect(result.rules).toHaveLength(1); } finally { source.close(); }
});
