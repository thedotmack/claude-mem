import { afterEach, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { buildContentOperation } from '../../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../../src/services/sync/SyncClient.js';
import { ReviewStackRoutes } from '../../../../src/services/worker/http/routes/ReviewStackRoutes.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../../../../src/shared/worker-http-limits.js';
import { _resetRedactionConfigCache } from '../../../../src/utils/redaction.js';
import { createSharedRecordReader, publishSharedRecords, readSharedRecordValue } from '../../../../src/services/work-view/shared-record-store.mjs';
import { isSharedProjectionValue } from '../../../../src/services/work-view/shared-projection.mjs';
import { prepareReviewStackWrite, reviewStackImage } from '../../../../src/services/work-view/review-stack.js';

const dispose: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close(); });

async function device(id: string) {
  const store = new SessionStore(':memory:');
  store.setLocalSyncDeviceId(id);
  dispose.push(() => store.close());
  let notifications = 0;
  const app = express();
  app.use(express.json({ limit: WORKER_JSON_BODY_LIMIT_BYTES }));
  new ReviewStackRoutes(store.db, id, () => { notifications++; }).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  dispose.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = origin + '/api/work-view/review-stack';
  return {
    id, store, origin, url, notifications: () => notifications,
    read: async () => (await fetch(url)).json(),
    write: (operation: 'import' | 'action', body: unknown, mutationId = randomUUID()) => fetch(url + '/' + operation, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': mutationId, Origin: origin },
      body: JSON.stringify(body),
    }),
  };
}

type ReviewDevice = Awaited<ReturnType<typeof device>>;
function transfer(from: ReviewDevice, to: ReviewDevice) {
  const rows = from.store.db.query('SELECT * FROM work_state_entries WHERE origin_device_id IS NULL ORDER BY id').all() as Array<{
    id: number; project: string; list_name: string; fields: string; created_at: string; created_at_epoch: number; sync_rev: string;
  }>;
  const apply = new SyncApply(to.store.db, { deviceId: to.id });
  const cursor = BigInt(apply.getCursor());
  const changes = rows.map((row, index) => ({
    seq: String(cursor + BigInt(index + 1)),
    ...buildContentOperation({
      kind: 'work_state', originDeviceId: from.id, originLocalId: String(row.id), entityRev: String(row.sync_rev),
      payload: { project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch) },
    }),
  }));
  apply.applyOps(decodeChanges(changes), { epoch: '1' });
}

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=';
const card = {
  key: 'artwork-1', title: 'Holiday Homepage Artwork', focus: 'Cloud Sync',
  what: 'A cloud illustration introduces the holiday offer on the homepage.',
  context: 'The team is reviewing illustrations for the holiday Cloud Sync campaign.',
  imageData: 'data:image/png;base64,' + image,
};

test('origin-guarded imports are atomic and retryable without a cloud account', async () => {
  const worker = await device('review-laptop');
  const mutationId = randomUUID();
  const payload = { cards: [card] };
  const added = await worker.write('import', payload, mutationId);
  expect(added.status).toBe(200);
  const receipt = await added.json();
  expect(receipt).toMatchObject({ added: 1, existing: 0, deckUrl: worker.origin + '/?view=review-stack' });
  expect(await (await worker.write('import', payload, mutationId)).json()).toEqual(receipt);
  expect(worker.notifications()).toBe(1);
  expect((await worker.write('import', { cards: [{ ...card, key: 'other' }] }, mutationId)).status).toBe(409);
  expect((await worker.write('import', { cards: [{ ...card, key: 'valid' }, { title: 'incomplete' }] })).status).toBe(400);
  const summary = await fetch(worker.url + '?summary=1');
  expect(summary.headers.get('cache-control')).toContain('no-store');
  expect(await summary.json()).toEqual({ itemCount: 1, deckUrl: worker.origin + '/?view=review-stack' });
  const snapshot = await worker.read();
  expect(snapshot.cards.map((item: { id: string }) => item.id)).toEqual([receipt.firstId]);
  expect(snapshot.nextCursor).toBeNull();
  const media = await fetch(`${worker.url}/media/${receipt.firstId}`);
  expect(media.status).toBe(200);
  expect(media.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await media.arrayBuffer()).toString('base64')).toBe(image);
  for (const route of [worker.url, `${worker.url}/media/${receipt.firstId}`]) {
    expect((await fetch(route, { headers: { Origin: 'https://other.example' } })).status).toBe(403);
  }
  expect((await fetch(worker.url + '/action', {
    method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}',
  })).status).toBe(403);
});

test('a card and its thumbnail arrive through normal work-state sync and a remote Seen decision returns to its origin', async () => {
  const laptop = await device('review-source'), replica = await device('review-replica');
  const imported = await (await laptop.write('import', { cards: [card] })).json();
  expect((await replica.read()).cards).toEqual([]);
  transfer(laptop, replica);
  expect((await replica.read()).cards[0].id).toBe(imported.firstId);
  expect((await fetch(`${replica.url}/media/${imported.firstId}`)).status).toBe(200);
  const seen = { action: 'seen', cardId: imported.firstId, expectedReviewId: null };
  const mutationId = randomUUID();
  expect((await replica.write('action', seen, mutationId)).status).toBe(200);
  expect((await replica.write('action', seen, mutationId)).status).toBe(200);
  transfer(replica, laptop);
  const reviewed = await laptop.read();
  expect(reviewed.reviews).toHaveLength(1);
  expect(reviewed.reviews[0]).toMatchObject({ cardId: imported.firstId, action: 'seen' });
  expect((await laptop.write('action', seen)).status).toBe(409);
});

test('the worker pages one deck revision and asks the client to restart when a review arrives mid-read', async () => {
  const worker = await device('review-pagination');
  const cards = Array.from({ length: 12 }, (_, index) => ({
    ...card, key: 'long-brief-' + index, imageData: undefined, excerpt: '漢'.repeat(16_000),
  }));
  expect((await worker.write('import', { cards })).status).toBe(200);
  const first = await worker.read();
  expect(first.nextCursor).toBeString();
  const restUrl = worker.url + '?cursor=' + encodeURIComponent(first.nextCursor);
  const second = await (await fetch(restUrl)).json();
  expect(second.revision).toBe(first.revision);
  expect(first.cards.length + second.cards.length).toBe(12);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024);
  expect((await worker.write('action', { action: 'seen', cardId: first.cards[0].id, expectedReviewId: null })).status).toBe(200);
  expect((await fetch(restUrl)).status).toBe(409);
});

test('metadata readers retain verified thumbnail locators and fetch just the image parts belonging to the requested card', async () => {
  const worker = await device('review-images');
  const large = Buffer.alloc(160 * 1024);
  Buffer.from(image, 'base64').copy(large);
  const imageData = 'data:image/png;base64,' + large.toString('base64');
  const imported = await (await worker.write('import', { cards: [
    { ...card, key: 'image-a', imageData }, { ...card, key: 'image-b', imageData },
  ] })).json();
  const options = { deviceId: worker.id, validateValue: isSharedProjectionValue };
  const heads = createSharedRecordReader(worker.store.db, { ...options, reviewStack: 'metadata' })();
  const images = [...heads.records.values()].filter(r => r.kind === 'stack-part');
  expect(images.length).toBeGreaterThan(2);
  expect(images.every(r => r.valueOmitted && r.value === null && Number.isSafeInteger(r.sourceId))).toBe(true);
  const full = createSharedRecordReader(worker.store.db, options)();
  expect(full.revision).toBe(heads.revision);
  expect([...full.records.values()].filter(r => r.kind === 'stack-part').every(r => typeof r.value === 'string')).toBe(true);
  const ordinary = createSharedRecordReader(worker.store.db, { ...options, reviewStack: 'exclude' })();
  expect(ordinary.records.size).toBe(0);
  expect(ordinary.diagnostics.invalid).toBe(0);
  const loaded: string[] = [];
  const selected = worker.store.db.transaction(() => reviewStackImage(heads.records.values(), imported.firstId, head => {
    loaded.push(head.key);
    return readSharedRecordValue(worker.store.db, worker.id, head);
  }))();
  expect(Buffer.from(selected!.bytes)).toEqual(large);
  expect(loaded.length).toBe(images.length / 2);
  expect(loaded.every(key => key.startsWith(imported.firstId + ':'))).toBe(true);
  expect(() => readSharedRecordValue(worker.store.db, worker.id, { ...images[0], sourceId: images.at(-1)!.sourceId })).toThrow();
});

function fixtureRedaction(name: string, regex: string) {
  const enabled = process.env.CLAUDE_MEM_REDACT_ENABLED, patterns = process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS;
  dispose.push(() => {
    if (enabled === undefined) delete process.env.CLAUDE_MEM_REDACT_ENABLED; else process.env.CLAUDE_MEM_REDACT_ENABLED = enabled;
    if (patterns === undefined) delete process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS; else process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS = patterns;
    _resetRedactionConfigCache();
  });
  process.env.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS = JSON.stringify([{ name, regex }]);
  return (on: boolean) => {
    process.env.CLAUDE_MEM_REDACT_ENABLED = String(on);
    _resetRedactionConfigCache();
  };
}

test('worker redaction covers reassembled excerpts, invalidates cached pages, and protects subsequent imports at rest', async () => {
  const sample = 'REVIEW_RULE_SAMPLE', marker = "<redacted type='review-fixture'/>";
  const setRedaction = fixtureRedaction('review-fixture', sample);
  setRedaction(false);
  const worker = await device('review-policy');
  const excerpt = '漢'.repeat(3994) + sample + '漢'.repeat(11_970);
  const cards = Array.from({ length: 12 }, (_, i) => ({ ...card, key: 'policy-' + i, imageData: undefined, excerpt }));
  expect((await worker.write('import', { cards })).status).toBe(200);
  const old = await worker.read();
  expect(old.cards[0].excerpt).toContain(sample);
  expect(old.nextCursor).toBeString();

  setRedaction(true);
  const current = await worker.read();
  expect(current.cards[0].excerpt).toContain(marker);
  expect(current.cards[0].excerpt).not.toContain(sample);
  expect(current.revision).not.toBe(old.revision);
  expect((await fetch(worker.url + '?cursor=' + encodeURIComponent(old.nextCursor))).status).toBe(409);
  const added = await (await worker.write('import', { cards: [{ ...cards[0], key: 'new-policy' }] })).json();

  setRedaction(false);
  const after = await worker.read();
  const persisted = after.cards.find((item: { id: string }) => item.id === added.firstId);
  expect(persisted.excerpt).toContain(marker);
  expect(persisted.excerpt).not.toContain(sample);
});

test('current policy masks saved card metadata, links, notes and focus names while actions retain stable identities', async () => {
  const values = ['RULE_A_SAMPLE', 'RULE_B_SAMPLE'];
  const setRedaction = fixtureRedaction('review-metadata', values.join('|'));
  setRedaction(false);
  const worker = await device('review-metadata-policy');
  const cards = Array.from({ length: 12 }, (_, i) => {
    const value = values[i % 2];
    return {
      key: 'original-' + value + '-' + i, focus: 'Launch ' + value, title: 'Holiday ' + value + ' Artwork',
      what: 'This ' + value + ' draft illustrates the upcoming spring launch campaign artwork.',
      context: 'The ' + value + ' project is choosing illustrations for its spring launch.',
      source: 'https://original.example/source/' + value, preview: 'https://original.example/preview/' + value,
      excerpt: '漢'.repeat(16_000), // pagination even when the excerpts themselves are unaffected by policy
    };
  });
  const { firstId } = await (await worker.write('import', { cards })).json();
  const noteId = randomUUID(), groupId = randomUUID();
  expect((await worker.write('action', { action: 'follow-up', cardId: firstId, body: 'Inspect ' + values[0] }, noteId)).status).toBe(200);
  expect((await worker.write('action', { action: 'seen-group', focus: cards[0].focus }, groupId)).status).toBe(200);
  const before = await worker.read();
  expect(before.nextCursor).toBeString();
  expect(before.cards[0].source).toMatch(/RULE_[AB]_SAMPLE/);

  setRedaction(true);
  const safe = await worker.read();
  expect(safe.revision).not.toBe(before.revision);
  expect((await fetch(worker.url + '?cursor=' + encodeURIComponent(before.nextCursor))).status).toBe(409);
  const pages = [safe];
  while (pages.at(-1).nextCursor) {
    pages.push(await (await fetch(worker.url + '?cursor=' + encodeURIComponent(pages.at(-1).nextCursor))).json());
  }
  for (const value of values) expect(JSON.stringify(pages)).not.toContain(value);
  const marker = "<redacted type='review-metadata'/>";
  for (const item of pages.flatMap(page => page.cards)) {
    expect(item.key).toBe(item.id);
    for (const field of ['focus', 'title', 'what', 'context']) expect(item[field]).toContain(marker);
    expect(item.source).toBeUndefined();
    expect(item.preview).toBeUndefined();
  }
  const note = pages.flatMap(page => page.followUps).find(n => n.id === noteId);
  expect(note).toMatchObject({ body: 'Inspect ' + marker, cardId: firstId });
  const group = pages.flatMap(page => page.groups).find(g => g.id === groupId);
  expect(group).toMatchObject({ focus: 'Launch ' + marker, count: 6 });
  expect((await worker.write('action', { action: 'set-follow-up', cardId: firstId, followUpId: note.id, closed: true, revision: note.revision })).status).toBe(200);
  expect((await worker.write('action', { action: 'undo-group', groupId })).status).toBe(200);
  const shown = pages.flatMap(page => page.cards);
  const selected = safe.cards[0], other = shown.find(item => item.focusId !== selected.focusId)!;
  expect(other.focus).toBe(selected.focus);
  expect((await worker.write('action', { action: 'seen-group', focus: selected.focus })).status).toBe(409);
  const visibleGroupId = randomUUID();
  expect((await worker.write('action', { action: 'seen-group', focus: selected.focus, cardId:selected.id }, visibleGroupId)).status).toBe(200);
  const updated = await worker.read();
  const last = await (await fetch(worker.url + '?cursor=' + encodeURIComponent(updated.nextCursor))).json();
  expect(last.groups.find((g: { id: string }) => g.id === visibleGroupId)).toMatchObject({ count:6, activeCount:6, focusId:selected.focusId });
  expect(last.reviews.map((review: { cardId:string }) => review.cardId).sort())
    .toEqual(shown.filter(item => item.focusId === selected.focusId).map(item => item.id).sort());
  expect((await worker.write('action', { action:'seen-group',focus:other.focus,cardId:other.id })).status).toBe(200);
  expect((await worker.write('action', { action:'undo-group',groupId:visibleGroupId })).status).toBe(200);
  const restored = await worker.read();
  const afterUndo = await (await fetch(worker.url + '?cursor=' + encodeURIComponent(restored.nextCursor))).json();
  expect(afterUndo.reviews.map((review: { cardId:string }) => review.cardId).sort())
    .toEqual(shown.filter(item => item.focusId === other.focusId).map(item => item.id).sort());
});

test('private sections stay out of new review records and follow-ups even with optional redaction off', async () => {
  const setRedaction = fixtureRedaction('review-private', 'OPTIONAL_RULE');
  setRedaction(false);
  const worker = await device('review-private-sections');
  const secret = 'PRIVATE_REVIEW_CONTENT';
  const hidden = '<private>' + secret + '</private>';
  const marked = {
    ...card, key:'public-asset', focus:'Launch' + hidden, title:card.title + hidden,
    what:card.what + hidden, context:card.context + hidden, excerpt:'Public excerpt' + hidden + ' and OPTIONAL_RULE',
    source:'https://assets.example/' + hidden, preview:'https://assets.example/cover/' + hidden,
  };
  const importId = randomUUID();
  const response = await worker.write('import', { cards:[marked] }, importId);
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(await (await worker.write('import', { cards:[marked] }, importId)).json()).toEqual(receipt);
  const followUpId = randomUUID();
  const note = { action:'follow-up', cardId:receipt.firstId, body:'Contact the owner.' + hidden };
  expect((await worker.write('action', note, followUpId)).status).toBe(200);
  expect((await worker.write('action', { ...note, body:note.body.replace(secret, secret + '2') }, followUpId)).status).toBe(409);
  const snapshot = await worker.read();
  const shown = snapshot.cards[0];
  expect(shown).toMatchObject({ id:receipt.firstId, key:'public-asset', focus:'Launch', title:card.title,
    what:card.what, context:card.context, excerpt:'Public excerpt and OPTIONAL_RULE' });
  expect(shown.source).toBeUndefined();
  expect(shown.preview).toBe('/api/work-view/review-stack/media/' + receipt.firstId);
  const media = await fetch(worker.origin + shown.preview);
  expect(Buffer.from(await media.arrayBuffer())).toEqual(Buffer.from(image, 'base64'));
  expect(snapshot.followUps[0]).toMatchObject({ id:followUpId, body:'Contact the owner.' });
  const rows = () => worker.store.db.query('SELECT fields FROM work_state_entries ORDER BY id').all();
  expect(JSON.stringify(rows())).not.toContain(secret);

  setRedaction(true);
  expect((await worker.read()).cards[0].excerpt).toContain("<redacted type='review-private'/>");
  const protectedImport = await worker.write('import', { cards:[{ ...marked, key:'both-policies' }] });
  expect(protectedImport.status).toBe(200);
  const protectedId = (await protectedImport.json()).firstId;
  setRedaction(false);
  const protectedCard = (await worker.read()).cards.find((item: { id:string }) => item.id === protectedId);
  expect(protectedCard.excerpt).toBe("Public excerpt and <redacted type='review-private'/>");
  expect(JSON.stringify(rows())).not.toContain(secret);

  const before = rows();
  expect((await worker.write('import', { cards:[{ ...marked, key:'asset-' + hidden }] })).status).toBe(400);
  const missingTitle = await worker.write('import', { cards:[{ ...marked, key:'missing-title', title:'<private>Entire Cover Title</private>' }] });
  expect(missingTitle.status).toBe(400);
  expect(await missingTitle.json()).toHaveProperty('error');
  expect((await worker.write('action', { ...note, body:hidden })).status).toBe(400);
  expect(rows()).toEqual(before);
});

test('older saved review records hide private sections when read, preserving their card and group identities', async () => {
  fixtureRedaction('review-legacy', 'UNUSED_FIXTURE_PATTERN')(false);
  const worker = await device('review-private-legacy');
  const hidden = '<private>PRIVATE_LEGACY_REVIEW</private>';
  const marked = { ...card, key:card.key + hidden, focus:'Launch' + hidden, title:card.title + hidden,
    what:card.what + hidden, context:card.context + hidden, excerpt:'Before' + hidden + ' and after',
    source:'https://assets.example/' + hidden, preview:'https://assets.example/art/' + hidden };
  // Recreate the older writer that emitted valid review rows without applying the author's private tags.
  const read = createSharedRecordReader(worker.store.db, { deviceId:worker.id, validateValue:isSharedProjectionValue });
  function legacyWrite(operation: 'import' | 'action', input: unknown, id = randomUUID()) {
    const write = prepareReviewStackWrite(read().records.values(), operation, input, id);
    publishSharedRecords(worker.store.db, { deviceId:worker.id, project:'__my_work__', updates:write.updates,
      validateValue:isSharedProjectionValue, reader:read });
    return write.result;
  }
  const imported = legacyWrite('import', { cards:[marked] });
  if (!('firstId' in imported)) throw new Error('Expected an import receipt.');
  const noteId = randomUUID(), groupId = randomUUID();
  legacyWrite('action', { action:'follow-up', cardId:imported.firstId, body:'Inspect original.' + hidden }, noteId);
  legacyWrite('action', { action:'seen-group', focus:marked.focus }, groupId);
  const snapshot = await worker.read();
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_LEGACY_REVIEW');
  expect(snapshot.cards[0]).toMatchObject({ id:imported.firstId, key:imported.firstId, focus:'Launch', title:card.title,
    what:card.what, context:card.context, excerpt:'Before and after' });
  expect(snapshot.cards[0].source).toBeUndefined();
  expect(snapshot.followUps[0]).toMatchObject({ id:noteId, cardId:imported.firstId, body:'Inspect original.' });
  expect(snapshot.groups[0]).toMatchObject({ id:groupId, focus:'Launch', count:1 });
  expect((await worker.write('action', { action:'undo-group', groupId })).status).toBe(200);
  expect((await worker.write('action', { action:'seen-group', focus:'Launch', cardId:imported.firstId })).status).toBe(200);
});
