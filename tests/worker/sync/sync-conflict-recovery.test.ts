import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { reserveRepair } from '../../../src/services/sync/SyncRepairReservation.js';
import { SyncConflictRecovery, initializeConflictRecoverySchema } from '../../../src/services/sync/SyncConflictRecovery.js';
import { buildContentOperation, parseCanonicalOperation, stableDocumentId } from '../../../src/services/sync/CanonicalContent.js';

describe('explicit native conflict recovery', () => {
  let db: Database, store: SessionStore, id: string, head: any, sends: number, reads: number;
  let onSend: (() => void) | null, onRead: (() => void) | null;
  let failResponse: boolean;
  const deviceId = 'dev-a';
  const config = () => ({ deviceId, userId: 'test-user', authToken: 'test-token', hubUrl: 'https://fixture.invalid', fetch: (async (url: any, init: any) => {
    const payload = JSON.parse(init.body);
    if (String(url).endsWith('/head')) {
      reads++; onRead?.();
      return Response.json({ protocol_version: 1, capability: 'origin-repair-v1', epoch: '19', entity_id: payload.entity_id,
        head_seq: head ? '1' : '0', projected_seq: head ? '1' : '0', head: head ? { entity_rev: JSON.parse(head.body).entity_rev, operation_sha256: head.operation_sha256, seq: '1' } : null, op: head });
    }
    sends++; onSend?.(); head = payload.op;
    if (failResponse) { failResponse = false; throw new Error('lost response'); }
    const body = JSON.parse(head.body);
    return Response.json({ protocol_version: 1, capability: 'origin-repair-v1', epoch: '19', head_seq: '1', projected_seq: '1',
      acked: [{ id: body.id, kind: body.kind, origin_local_id: body.origin_local_id, entity_rev: body.entity_rev, operation_sha256: head.operation_sha256, seq: '1' }] });
  }) as typeof fetch });
  beforeEach(() => {
    db = new Database(':memory:'); store = new SessionStore(db); initializeConflictRecoverySchema(db);
    db.prepare(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status)
      VALUES ('s','m','p','2026-01-01T00:00:00Z',1767225600000,'active')`).run();
    id = String(store.storeObservation('m','p',{ type: 'discovery', title: 'authoritative local', subtitle: null, facts: [], narrative: 'private body', concepts: [], files_read: [], files_modified: [] },1,0).id);
    head = null; sends = 0; reads = 0; onSend = null; onRead = null; failResponse = false;
  });
  afterEach(() => db.close());
  const preview = (recovery: SyncConflictRecovery) => recovery.preview({ kind: 'observation', originLocalId: id, choice: 'local_current' });
  function retainUnknown(lane: 'pull' | 'dead', revision: string | null): void {
    const entityId = stableDocumentId('observation', deviceId, id);
    if (lane === 'pull') db.prepare(`INSERT INTO sync_pull_quarantine(epoch,seq,entity_id,entity_rev,reason,raw_body,created_at_epoch)
      VALUES('19','unknown',?,?,'malformed revision','retained original diagnostic',1)`).run(entityId,revision);
    else db.prepare(`INSERT INTO sync_dead_letter(lane,queue_key,entity_rev,reason,raw_body,created_at_epoch)
      VALUES('content',?,?,'malformed revision','retained original diagnostic',1)`).run(entityId,revision);
  }

  for (const lane of ['pull','dead'] as const) for (const revision of [null,'malformed','01','18446744073709551616']) {
    it(`refuses ${lane} evidence with unknown revision ${String(revision)} before preview sends or writes`, async () => {
      retainUnknown(lane,revision); const before=db.serialize();
      await expect(preview(new SyncConflictRecovery(db,config()))).rejects.toMatchObject({code:'repair_evidence_revision_unknown'});
      expect(reads).toBe(0);expect(sends).toBe(0);expect(db.serialize()).toEqual(before);
    });
  }
  for (const lane of ['pull','dead'] as const) {
    it(`refuses apply when unknown ${lane} evidence arrives after preview without discarding it`, async () => {
      const recovery=new SyncConflictRecovery(db,config());const p=await preview(recovery);
      retainUnknown(lane,null); const before=db.serialize();
      await expect(recovery.apply({previewToken:p.previewToken})).rejects.toMatchObject({code:'repair_evidence_revision_unknown'});
      expect(sends).toBe(0);expect(db.serialize()).toEqual(before);
      expect(db.query('SELECT COUNT(*) AS n FROM sync_conflict_repairs').get()).toEqual({n:0});
    });
    it(`keeps an accepted receipt incomplete and retryable when unknown ${lane} evidence arrives in flight`, async () => {
      const recovery=new SyncConflictRecovery(db,config());const p=await preview(recovery);
      onSend=()=>retainUnknown(lane,null);
      const result=await recovery.apply({previewToken:p.previewToken});
      expect(result).toMatchObject({state:'accepted_unresolved_evidence',acknowledgedSeq:'1'});
      expect(db.prepare('SELECT sync_rev,synced_at FROM observations WHERE id=?').get(id)).toEqual({sync_rev:'1',synced_at:null});
      const retry=await new SyncConflictRecovery(db,config()).apply({previewToken:p.previewToken});
      expect(retry).toEqual(result);expect(sends).toBe(1);
      expect(db.prepare('SELECT state,acknowledged_seq FROM sync_conflict_repairs WHERE token=?').get(p.previewToken))
        .toEqual({state:'accepted_unresolved_evidence',acknowledged_seq:'1'});
      const table=lane==='pull'?'sync_pull_quarantine':'sync_dead_letter';
      expect(db.query(`SELECT raw_body,entity_rev FROM ${table}`).get()).toEqual({raw_body:'retained original diagnostic',entity_rev:null});
    });
  }

  it('preview performs zero writes/uploads and returns no body or diagnostic text', async () => {
    const recovery = new SyncConflictRecovery(db, config());
    const before = db.prepare('SELECT total_changes() AS n').get();
    const p = await preview(recovery);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(sends).toBe(0); expect(reads).toBe(1);
    expect(JSON.stringify(p)).not.toContain('private body');
    expect(JSON.stringify(p)).not.toContain('authoritative local');
  });
  it('chooses above every head/outbox/quarantine revision without number conversion; retains evidence', async () => {
    const entityId = stableDocumentId('observation', deviceId, id);
    db.prepare(`INSERT INTO sync_pull_quarantine(epoch,seq,entity_id,entity_rev,operation_sha256,reason,raw_body,created_at_epoch)
      VALUES('19','1',?,'9007199254740997','hash','retained','redacted-not-a-wrapper',1)`).run(entityId);
    const recovery = new SyncConflictRecovery(db, config()); const p = await preview(recovery);
    expect(p.proposedRevision).toBe('9007199254740998');
    const result = await recovery.apply({ previewToken: p.previewToken }); expect(result.state).toBe('verified');
    expect(db.prepare('SELECT raw_body FROM sync_pull_quarantine').get()).toEqual({ raw_body: 'redacted-not-a-wrapper' });
    expect(db.prepare('SELECT evidence FROM sync_conflict_repairs').get()).toBeTruthy();
  });
  it('refuses an edited source and a retained tombstone before upload', async () => {
    const recovery = new SyncConflictRecovery(db, config()); const p = await preview(recovery);
    db.prepare('UPDATE observations SET narrative=?,sync_rev=? WHERE id=?').run('newer','2',id);
    await expect(recovery.apply({ previewToken: p.previewToken })).rejects.toMatchObject({ code: 'local_evidence_changed' }); expect(sends).toBe(0);
    const op = buildContentOperation({ kind: 'observation', originDeviceId: deviceId, originLocalId: id, entityRev: '3', payload: null, deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' });
    db.prepare(`INSERT INTO sync_content_outbox(entity_id,kind,origin_local_id,entity_rev,body,operation_sha256,deleted,created_at_epoch)
      VALUES(?,'observation',?,'3',?,?,1,1)`).run(stableDocumentId('observation',deviceId,id),id,op.body,op.operation_sha256);
    await expect(preview(recovery)).rejects.toMatchObject({ code: 'native_tombstone_requires_new_preview' });
  });
  it('never stamps an edit during upload or reports verified after an edit during final read', async () => {
    const recovery = new SyncConflictRecovery(db, config()); const p = await preview(recovery);
    onSend = () => db.prepare('UPDATE observations SET narrative=?,sync_rev=? WHERE id=?').run('live edit','7',id);
    expect((await recovery.apply({ previewToken: p.previewToken })).state).toBe('accepted_local_or_hub_changed');
    expect(db.prepare('SELECT sync_rev,narrative FROM observations WHERE id=?').get(id)).toEqual({ sync_rev: '7', narrative: 'live edit' });
    onSend = null; const p2 = await preview(recovery); let calls = 0;
    onRead = () => { if (++calls === 1) db.prepare('UPDATE observations SET narrative=?,sync_rev=? WHERE id=?').run('final edit','99',id); };
    expect((await recovery.apply({ previewToken: p2.previewToken })).state).toBe('accepted_local_or_hub_changed');
  });
  it('recovers a lost reply after restart by exact retained request and refuses unavailable capability', async () => {
    const recovery = new SyncConflictRecovery(db, config()); const p = await preview(recovery); failResponse = true;
    await expect(recovery.apply({ previewToken: p.previewToken })).rejects.toMatchObject({ code: 'repair_transport_unavailable' });
    await expect(new SyncConflictRecovery(db, { ...config(), userId: 'wrong-account' }).apply({ previewToken: p.previewToken }))
      .rejects.toMatchObject({ code: 'repair_scope_changed' });
    expect((await new SyncConflictRecovery(db, config()).apply({ previewToken: p.previewToken })).state).toBe('verified');
    const unsupported = new SyncConflictRecovery(db, { ...config(), fetch: (async () => new Response('',{status:404})) as typeof fetch });
    await expect(preview(unsupported)).rejects.toMatchObject({ code: 'repair_capability_unavailable' });
  });
  it('keeps a deletion during upload authoritative with a strictly higher ordinary tombstone', async () => {
    const recovery = new SyncConflictRecovery(db, config()); const p = await preview(recovery);
    onSend = () => { db.prepare('DELETE FROM observations WHERE id=?').run(id); };
    expect((await recovery.apply({ previewToken: p.previewToken })).state).toBe('accepted_local_or_hub_changed');
    const queued: any = db.prepare('SELECT * FROM sync_content_outbox WHERE deleted=1').get();
    expect(queued.entity_rev).toBe('3'); expect(parseCanonicalOperation({body:queued.body,operation_sha256:queued.operation_sha256}).deleted).toBe(true);
  });
  it('does not verify matching native bytes while a higher frozen revision remains', async () => {
    const recovery = new SyncConflictRecovery(db, config()); const p = await preview(recovery);
    onSend = () => {
      db.prepare('UPDATE observations SET sync_rev=? WHERE id=?').run(p.proposedRevision,id);
      const frozen = buildContentOperation({kind:'observation',originDeviceId:deviceId,originLocalId:id,
        entityRev:'9',payload:parseCanonicalOperation(getNativeContentOperation(db,'observation',id,deviceId)!.operation).payload!});
      db.prepare(`INSERT INTO sync_content_outbox(entity_id,kind,origin_local_id,entity_rev,body,operation_sha256,deleted,created_at_epoch)
        VALUES(?,'observation',?,'9',?,?,0,1)`).run(p.entityId,id,frozen.body,frozen.operation_sha256);
    };
    expect((await recovery.apply({previewToken:p.previewToken})).state).toBe('accepted_local_or_hub_changed');
    expect(db.prepare('SELECT sync_rev,synced_at FROM observations WHERE id=?').get(id)).toEqual({sync_rev:'10',synced_at:null});
  });
  it('bounds displayed conflict metadata while fencing every higher revision and refuses foreign rows', async () => {
    const entityId = stableDocumentId('observation', deviceId, id);
    for (let i = 1; i <= 105; i++) db.prepare(`INSERT INTO sync_pull_quarantine(epoch,seq,entity_id,entity_rev,reason,raw_body,created_at_epoch)
      VALUES('19',?,?,?,'do not expose me','private quarantine body',1)`).run(String(i),entityId,String(i));
    const recovery = new SyncConflictRecovery(db, config()); const p = await preview(recovery);
    expect(p.conflictCount).toBe(105); expect(p.conflicts).toHaveLength(100); expect(p.proposedRevision).toBe('106');
    expect(JSON.stringify(p)).not.toContain('private quarantine body');
    db.prepare('UPDATE observations SET origin_device_id=? WHERE id=?').run('foreign-device',id);
    await expect(preview(recovery)).rejects.toMatchObject({ code: 'native_origin_required' });
  });
  it('refuses preview when a known local epoch differs from the authoritative hub epoch', async () => {
    db.prepare("INSERT INTO sync_state(k,v) VALUES('epoch','20')").run();
    await expect(preview(new SyncConflictRecovery(db,config()))).rejects.toMatchObject({code:'local_epoch_changed'});
    expect(sends).toBe(0);
  });
  it('does not stamp an ordinary acknowledgement below a newly reserved repair revision', async () => {
    const revisions: string[]=[]; let sequence=0;
    const fetchImpl=(async (_url:any,init:any)=>{
      const ops=JSON.parse(init.body).ops;
      const bodies=ops.map((op:any)=>parseCanonicalOperation(op));
      if(revisions.length===0) {
        const reservation=getNativeContentOperation(db,'observation',id,deviceId,'11')!.operation;
        reserveRepair(db,bodies[0].id,'11',reservation.operation_sha256);
      } else expect((db.prepare('SELECT synced_at FROM observations WHERE id=?').get(id) as any).synced_at).toBeNull();
      revisions.push(...bodies.map((body:any)=>body.entity_rev));
      return Response.json({head_seq:String(sequence+ops.length),projected_seq:String(sequence+ops.length),acked:ops.map((op:any,i:number)=>({
        id:bodies[i].id,kind:bodies[i].kind,origin_local_id:bodies[i].origin_local_id,entity_rev:bodies[i].entity_rev,
        operation_sha256:op.operation_sha256,seq:String(++sequence)}))});
    }) as typeof fetch;
    const sync=new CloudSync(db,{CLAUDE_MEM_CLOUD_SYNC_TOKEN:'fixture',CLAUDE_MEM_CLOUD_SYNC_USER_ID:'fixture',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL:'https://fixture.invalid',CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:deviceId},{fetchImpl});
    try { await sync.flush(); expect(revisions).toEqual(['1','12']); }
    finally {sync.stop();}
  });
  it('replaces an inadequate queued tombstone with one above a newly reserved repair', async () => {
    const deletedRevisions:string[]=[]; let sequence=0,first=true;
    const fetchImpl=(async (_url:any,init:any)=>{
      const ops=JSON.parse(init.body).ops, bodies=ops.map((op:any)=>parseCanonicalOperation(op));
      if(first) {
        first=false;const reservation=getNativeContentOperation(db,'observation',id,deviceId,'11')!.operation;
        reserveRepair(db,bodies[0].id,'11',reservation.operation_sha256);
        db.prepare('DELETE FROM observations WHERE id=?').run(id);
        const low=buildContentOperation({kind:'observation',originDeviceId:deviceId,originLocalId:id,entityRev:'2',payload:null,
          deleted:true,deletedAt:'2026-01-02T00:00:00.000Z'});
        db.prepare(`INSERT INTO sync_content_outbox(entity_id,kind,origin_local_id,entity_rev,body,operation_sha256,deleted,created_at_epoch)
          VALUES(?,'observation',?,'2',?,?,1,1)`).run(bodies[0].id,id,low.body,low.operation_sha256);
      }
      deletedRevisions.push(...bodies.filter((body:any)=>body.deleted).map((body:any)=>body.entity_rev));
      return Response.json({head_seq:String(sequence+ops.length),projected_seq:String(sequence+ops.length),acked:ops.map((op:any,i:number)=>({
        id:bodies[i].id,kind:bodies[i].kind,origin_local_id:bodies[i].origin_local_id,entity_rev:bodies[i].entity_rev,
        operation_sha256:op.operation_sha256,seq:String(++sequence)}))});
    }) as typeof fetch;
    const sync=new CloudSync(db,{CLAUDE_MEM_CLOUD_SYNC_TOKEN:'fixture',CLAUDE_MEM_CLOUD_SYNC_USER_ID:'fixture',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL:'https://fixture.invalid',CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:deviceId},{fetchImpl});
    try {await sync.flush();expect(deletedRevisions).toContain('12');}
    finally {sync.stop();}
  });
});
