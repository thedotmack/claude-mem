import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ReviewStackImportCard } from '../../../src/shared/review-stack.js';
import { createWorkStateSchema, getWorkStateEntries } from '../../../src/services/sqlite/work-state.js';
import {
  foldCloudBatch, prepareReviewStackWrite, renderCloudWorkView, renderReviewStack,
  reviewStackPage, reviewStackImage, ReviewStackError, isSharedProjectionValue,
} from '../../../src/services/work-view/cloud-renderer.js';
import type { ReviewStackRecord, ReviewStackUpdate } from '../../../src/services/work-view/review-stack.js';
import { publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { SHARED_WORK_MAX_VALUE_BYTES, sharedValueHash } from '../../../src/services/work-view/shared-records.mjs';

const card = (key: string, extra: Partial<ReviewStackImportCard> = {}): ReviewStackImportCard => ({
  key, focus: 'App design', title: 'Review this original',
  what: 'This is the original design submitted to the team for review.',
  context: 'The team uses this card to decide which draft to publish.',
  source: 'https://chatgpt.com/library?file_id=original&account_id=personal', ...extra,
});
const idFor = (key: string) => 'weekly-' + createHash('sha256').update(key).digest('hex');
const recorded = (updates: ReviewStackUpdate[], writer = 'fixture'): ReviewStackRecord[] =>
  updates.map(({kind, key, value}) => ({
    kind, key, value, writer, deleted: false, revision: '1', hash: sharedValueHash(kind,key,value), batchId: 'fixture',
  }));
function fixture() {
  const records: ReviewStackRecord[] = [];
  const write = (op: 'import' | 'action', body: unknown, id = randomUUID(), at = 100) => {
    const result = prepareReviewStackWrite(records, op, body, id, at);
    records.push(...recorded(result.updates));
    return { ...result, id };
  };
  return { records, write, view: () => renderReviewStack(records) };
}
function thumbnail(bytes: number) {
  const file = Buffer.alloc(bytes, 0xff);
  Buffer.from('89504e470d0a1a0a','hex').copy(file);
  return { file, imageData: 'data:image/png;base64,' + file.toString('base64') };
}
describe('private Work View review stack', () => {
  test('imports original assets atomically, preserves a 160 KiB image and Unicode text across native/cloud batches', () => {
    const db = new Database(':memory:');
    createWorkStateSchema(db);
    try {
      const image = thumbnail(160 * 1024);
      const excerpt = '漢🐝é'.repeat(2800);
      const input = card('source-original', { excerpt, imageData: image.imageData });
      const { updates, result } = prepareReviewStackWrite([], 'import', { cards: [input, input] }, randomUUID(), 10);
      const id = idFor(input.key);
      expect(result).toEqual({ added: 1, existing: 1, firstId: id });
      expect(updates.length).toBeGreaterThan(7);
      for (const u of updates) {
        expect(isSharedProjectionValue(u.kind, u.key, u.value, false)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(u.value))).toBeLessThanOrEqual(SHARED_WORK_MAX_VALUE_BYTES);
      }
      publishSharedRecords(db, { deviceId:'author', project:'My Work', updates, validateValue:isSharedProjectionValue });
      const state = readSharedRecords(db, { deviceId:'author', validateValue:isSharedProjectionValue });
      const fromNative = renderReviewStack(state.records.values());
      expect(fromNative.cards).toEqual([{ ...input, id, createdAt:10, focusId:expect.stringMatching(/^focus-[a-f0-9]{64}$/) }]);
      const rows = db.query('SELECT id,list_name,fields FROM work_state_entries ORDER BY id').all() as
        { id: number; list_name: string; fields: string }[];
      const cloudRows = rows.map(row => ({ ...row, origin_device_id:'author', origin_local_id:String(row.id) }));
      const complete = foldCloudBatch(cloudRows.reverse());
      expect(complete.invalid).toBe(0);
      expect(renderReviewStack(complete.members)).toEqual(fromNative);
      expect(foldCloudBatch(cloudRows.filter(row => !row.list_name.endsWith(':commit'))).members).toHaveLength(0);
      expect(getWorkStateEntries(db, ['My Work'])).toEqual([]);
      const ordinaryOverview = JSON.stringify(renderCloudWorkView({now:100,revision:'1',sharedHeads:complete.members}));
      expect(ordinaryOverview).not.toContain(input.title);
      expect(ordinaryOverview).not.toContain(image.imageData.slice(0,80));
      const skim = complete.members.map(r => r.kind === 'stack-part' && r.key.includes(':image:')
        ? { ...r, value:null, valueOmitted:true as const } : r);
      expect(renderReviewStack(skim, {thumbnailUrl: key => '/media/' + key}).cards[0]).toMatchObject({preview:'/media/'+id, excerpt});
      expect(reviewStackImage(skim,id)).toBeNull();
      let hydrated = 0;
      const lazilyLoaded = reviewStackImage(skim, id, head => {
        hydrated++;
        return complete.members.find(part => part.kind === head.kind && part.key === head.key)?.value;
      });
      expect(hydrated).toBe(7);
      expect(Buffer.from(lazilyLoaded!.bytes)).toEqual(image.file);
      expect(Buffer.from(reviewStackImage(complete.members,id)!.bytes)).toEqual(image.file);
      const incomplete = complete.members.filter(r => !r.key.endsWith(':image:1'));
      expect(renderReviewStack(incomplete,{thumbnailUrl: key => key}).cards).toEqual([]);
      expect(reviewStackImage(incomplete,id)).toBeNull();
      const corrupt = complete.members.map(record => record.key.endsWith(':image:1')
        ? { ...record, value: 'A'.repeat((record.value as string).length) } : record);
      expect(reviewStackImage(corrupt, id)).toBeNull();
    } finally { db.close(); }
  });
  test('rejects an invalid batch before any write; byte limit, URL, unsafe MIME and missing originals', () => {
    const f=fixture();
    const invalid = [
      card('bad', {source:undefined}),
      card('bad',{source:'javascript:alert(1)'}),
      card('bad',{source:'https://name:pass@example.com/'}),
      card('bad',{imageData:thumbnail(160*1024+1).imageData}),
      card('bad',{imageData:'data:image/jpeg;base64,iVBORw0KGgo='}),
      card('bad',{imageData:'data:image/svg+xml;base64,PHN2Zz4='}),
      card('bad',{title:'two words'}),
    ];
    for (const badCard of invalid) expect(() => f.write('import',{cards:[card('valid'),badCard]})).toThrow(ReviewStackError);
    expect(f.records).toEqual([]);
    expect(() => f.write('import', { cards:Array.from({length:13},(_,i)=>card(String(i))) })).toThrow(ReviewStackError);
  });
  test('the widest original fits byte-bounded parts and read-time disclosure pins the next-page cursor', () => {
    const wide = '漢'.repeat(15_998) + '界門';
    const write = prepareReviewStackWrite([], 'import', {cards:[card('wide', {excerpt:wide})]}, randomUUID(), 10);
    const chunks = write.updates.filter(u => u.key.includes(':excerpt:'));
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(isSharedProjectionValue(chunk.kind, chunk.key, chunk.value, false)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(chunk.value))).toBeLessThanOrEqual(SHARED_WORK_MAX_VALUE_BYTES);
    }
    const records = recorded(write.updates);
    const open = renderReviewStack(records);
    const filtered = renderReviewStack(records, {redactText: text => text.replace('界門', '[private]')});
    expect(open.cards[0].excerpt).toBe(wide);
    expect(filtered.cards[0].excerpt).toBe('漢'.repeat(15_998) + '[private]');
    expect(filtered.revision).not.toBe(open.revision);
    expect(() => reviewStackPage(filtered, open.revision + '.1')).toThrow(ReviewStackError);
    const changedDisclosure = records.map(r => r.kind === 'stack-card' ? {...r, valueHash:'recipient-hash'} : r);
    expect(renderReviewStack(changedDisclosure).revision).not.toBe(open.revision);
  });
  test('prepares safe metadata, links and follow-ups while preserving verified uploaded media and idempotency', () => {
    const redactText = (s: string) => s.replaceAll('SENSITIVE', "<redacted type='fixture'/>");
    const asset = thumbnail(48);
    const input = card('original-artwork', {
      title:'Review this SENSITIVE original', focus:'SENSITIVE design',
      what:'This SENSITIVE cover draft features illustrations from the new edition.',
      context:'The SENSITIVE team is choosing which illustration appears in print.',
      source:'https://example.org/SENSITIVE', preview:'https://preview.example.org/SENSITIVE', imageData:asset.imageData,
    });
    const importId = randomUUID();
    const imported = prepareReviewStackWrite([], 'import', {cards:[input]}, importId, 1, {redactText});
    expect(JSON.stringify(imported.updates)).not.toContain('SENSITIVE');
    const rows = recorded(imported.updates);
    const id = idFor(input.key);
    const plain = renderReviewStack(rows).cards[0];
    expect(plain.source).toBeUndefined();
    expect(plain.preview).toBeUndefined();
    expect(plain.imageData).toBe(asset.imageData);
    expect(plain.focus).toBe("<redacted type='fixture'/> design");
    const mediaPath = '/api/work-view/review-stack/media/' + id;
    const local = renderReviewStack(rows, {thumbnailUrl:()=>mediaPath, redactText});
    expect(local.cards[0].preview).toBe(mediaPath);
    expect(renderReviewStack(rows, {redactText}).revision).toBe(local.revision);
    expect(renderReviewStack(rows, {thumbnailUrl:()=>'/another/host/media', redactText}).revision).toBe(local.revision);
    expect(Buffer.from(reviewStackImage(rows, id)!.bytes)).toEqual(asset.file);
    expect(prepareReviewStackWrite(rows, 'import', {cards:[input]}, importId, 2, {redactText}).updates).toEqual([]);
    const note = {action:'follow-up', cardId:id, body:'Check the SENSITIVE version.'};
    const noteId = randomUUID();
    const wrote = prepareReviewStackWrite(rows, 'action', note, noteId, 2, {redactText});
    expect(JSON.stringify(wrote.updates)).not.toContain('SENSITIVE');
    const after = [...rows, ...recorded(wrote.updates)];
    expect(renderReviewStack(after).followUps[0].body).toBe("Check the <redacted type='fixture'/> version.");
    expect(prepareReviewStackWrite(after, 'action', note, noteId, 3, {redactText}).updates).toEqual([]);
    expect(() => prepareReviewStackWrite([], 'import', {cards:[card('SENSITIVE-key')]}, randomUUID(), 1, {redactText})).toThrow(ReviewStackError);
    expect(() => prepareReviewStackWrite([], 'import', {cards:[card('only-link', {source:'https://example.org/SENSITIVE'})]}, randomUUID(), 1, {redactText})).toThrow(ReviewStackError);
  });
  test('replays identical mutation IDs and identifies changed bodies without resurrecting old decisions', () => {
    const f=fixture(), id=idFor('one');
    const first=f.write('import',{cards:[card('one')]});
    expect(f.write('import',{cards:[card('one')]},first.id).updates).toEqual([]);
    expect(() => f.write('import',{cards:[card('other')]},first.id)).toThrow(ReviewStackError);
    expect(f.write('import',{cards:[card('one',{title:'A different description'})]}).result).toEqual({added:0,existing:1,firstId:id});
    expect(f.view().cards[0].title).toBe('Review this original');
    const action={action:'seen',cardId:id,expectedReviewId:null};
    const swipe=f.write('action',action);
    f.write('action',{action:'undo',cardId:id,reviewId:swipe.id});
    expect(f.write('action',action,swipe.id).updates).toEqual([]);
    expect(f.view().reviews).toEqual([]);
    expect(() => f.write('action',{action:'skip',cardId:id,expectedReviewId:null},swipe.id)).toThrow(ReviewStackError);
    expect(() => f.write('action',{action:'seen',cardId:id,expectedReviewId:swipe.id})).toThrow(ReviewStackError);
  });
  test('older cards without a stored focus identity keep their original scope when labels become identical', () => {
    const write = prepareReviewStackWrite([], 'import', {cards:[card('one',{focus:'Team North'}),card('two',{focus:'Team South'})]}, randomUUID(), 1);
    const legacy = recorded(write.updates.map(update => {
      if (update.kind !== 'stack-card') return update;
      const {focusId, ...priorCard} = update.value as Record<string, unknown>;
      return {...update, value:priorCard};
    }));
    const redactText = (s: string) => s.replace(/North|South/g, 'private');
    const view = renderReviewStack(legacy, {redactText});
    const [first, second] = view.cards;
    expect(first.focus).toBe(second.focus);
    expect(first.focusId).not.toBe(second.focusId);
    expect(() => prepareReviewStackWrite(legacy, 'action', {action:'seen-group',focus:first.focus}, randomUUID(), 2, {redactText})).toThrow(ReviewStackError);
    const mark = prepareReviewStackWrite(legacy, 'action', {action:'seen-group',focus:first.focus,cardId:first.id}, randomUUID(), 2, {redactText});
    const merged = renderReviewStack([...legacy, ...recorded(mark.updates)]);
    expect(merged.reviews.map(r => r.cardId)).toEqual([first.id]);
    expect(merged.groups[0].focusId).toBe(first.focusId);
  });
  test('undo group restores displaced skips, preserves individual changes, new cards, and independent feedback', () => {
    const f=fixture(), a=idFor('a'), b=idFor('b'), c=idFor('c');
    f.write('import',{cards:['a','b','c'].map(k=>card(k))});
    const skip=f.write('action',{action:'skip',cardId:a,expectedReviewId:null});
    const group=f.write('action',{action:'seen-group',focus:'APP DESIGN'});
    expect(f.view().groups[0].activeCount).toBe(3);
    const groupReview=f.view().reviews.find(r=>r.cardId===b)!;
    f.write('action',{action:'undo',cardId:b,reviewId:groupReview.id},undefined,1);
    const reSeen=f.write('action',{action:'seen',cardId:b,expectedReviewId:null},undefined,1);
    f.write('action',{action:'bookmark',cardId:c,revision:0,saved:true});
    const note=f.write('action',{action:'follow-up',cardId:c,body:'Revise the cover'});
    f.write('action',{action:'set-follow-up',cardId:c,followUpId:note.id,closed:true,revision:1});
    expect(() => f.write('action',{action:'bookmark',cardId:c,revision:0,saved:false})).toThrow(ReviewStackError);
    expect(() => f.write('action',{action:'set-follow-up',cardId:c,followUpId:note.id,closed:false,revision:1})).toThrow(ReviewStackError);
    f.write('import',{cards:[card('later')]},undefined,0);
    f.write('action',{action:'undo-group',groupId:group.id},undefined,0);
    const view=f.view();
    expect(view.groups).toEqual([]);
    expect(view.reviews.find(r=>r.cardId===a)).toMatchObject({id:skip.id,action:'skip'});
    expect(view.reviews.find(r=>r.cardId===b)).toMatchObject({id:reSeen.id,action:'seen'});
    expect(view.reviews.some(r=>r.cardId===c || r.cardId===idFor('later'))).toBe(false);
    expect(view.bookmarks[0]).toMatchObject({cardId:c,saved:true});
    expect(view.followUps[0]).toMatchObject({cardId:c,revision:2,closedAt:100,body:'Revise the cover'});
    expect(() => f.write('action',{action:'undo-group',groupId:group.id})).toThrow(ReviewStackError);
  });
  test('two offline decisions converge on every device, with clock-ordered undo and no timing dependency', () => {
    const f=fixture(), asset=idFor('source');
    f.write('import',{cards:[card('source')]});
    const a=prepareReviewStackWrite(f.records,'action',{action:'seen',cardId:asset,expectedReviewId:null},'00000000-0000-4000-8000-000000000001',1000);
    const b=prepareReviewStackWrite(f.records,'action',{action:'skip',cardId:asset,expectedReviewId:null},'00000000-0000-4000-8000-000000000002',5);
    const both=[...f.records,...recorded(b.updates,'B'),...recorded(a.updates,'A')];
    expect(renderReviewStack(both).reviews[0].action).toBe('seen');
    expect(renderReviewStack(both)).toEqual(renderReviewStack([...both].reverse()));
  });
  test('byte-bounded pages cover every collection and reject a stale cursor', () => {
    const f=fixture();
    for (let batch=0;batch<4;batch++) f.write('import',{cards:Array.from({length:12},(_,i)=>card(batch+':'+i,{excerpt:'漢'.repeat(8000)}))});
    const view=f.view(), ids:string[]=[];
    let page=reviewStackPage(view), sample=page.nextCursor;
    do {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(512*1024);
      ids.push(...page.cards.map(c=>c.id));
      if (!page.nextCursor) break;
      page=reviewStackPage(view,page.nextCursor);
    } while(true);
    expect(ids).toEqual(view.cards.map(c=>c.id));
    expect(sample).toBeTruthy();
    expect(() => reviewStackPage({...view,revision:'0'.repeat(64)},sample)).toThrow(ReviewStackError);
  });
});
