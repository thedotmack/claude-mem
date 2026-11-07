import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { SyncConflictRecovery, initializeConflictRecoverySchema } from '../../../src/services/sync/SyncConflictRecovery.js';
import { buildContentOperation, parseCanonicalOperation } from '../../../src/services/sync/CanonicalContent.js';
import { trackedApp, uniqueUser, pushRequest } from './helpers';

async function fixture(initialRevision = '10') {
  const { app } = await trackedApp(); const user = uniqueUser(), device = 'repair-boundary-device';
  const db = new Database(':memory:'); const store = new SessionStore(db); initializeConflictRecoverySchema(db);
  db.run(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status)
    VALUES('s','m','p','2026-01-01T00:00:00Z',1767225600000,'active')`);
  const id = String(store.storeObservation('m','p',{type:'discovery',title:'local',subtitle:null,facts:[],narrative:'body',concepts:[],files_read:[],files_modified:[]},1,0).id);
  const native = getNativeContentOperation(db,'observation',id,device)!.operation;
  const high = buildContentOperation({kind:'observation',originDeviceId:device,originLocalId:id,entityRev:initialRevision,payload:parseCanonicalOperation(native).payload!});
  expect((await pushRequest(app,user,device,[high])).status).toBe(200);
  const epoch = (await app.store.getRepairHead(user,device,parseCanonicalOperation(native).id)).epoch;
  db.prepare("INSERT INTO sync_state(k,v) VALUES('epoch',?)").run(epoch);
  const config = {deviceId:device,userId:user,hubUrl:app.url,authToken:`valid-for:${user}`};
  return { app,user,device,db,id,native,epoch,config };
}

describe('real hub/local repair boundaries', () => {
  it('reserves a lost high repair reply before deletion and retries with the native row absent', async () => {
    const f = await fixture(); let lose = true;
    const config = {...f.config,fetch:(async(url:any,init:any)=>{
      const response=await fetch(url,init);
      if(lose && String(url).endsWith('/repair')) { lose=false; expect(response.status).toBe(200); throw Error('lost reply'); }
      return response;
    }) as typeof fetch};
    const sync = new CloudSync(f.db,{CLAUDE_MEM_CLOUD_SYNC_TOKEN:config.authToken,CLAUDE_MEM_CLOUD_SYNC_USER_ID:f.user,
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL:f.app.url,CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:f.device});
    try {
      const recovery=new SyncConflictRecovery(f.db,config); const preview=await recovery.preview({kind:'observation',originLocalId:f.id,choice:'local_current'});
      expect(preview.proposedRevision).toBe('11');
      await expect(recovery.apply({previewToken:preview.previewToken})).rejects.toMatchObject({code:'repair_transport_unavailable'});
      expect(sync.queueDelete('observation',f.id)).toBe('12');
      const retried=await new SyncConflictRecovery(f.db,config).apply({previewToken:preview.previewToken});
      expect(retried.state).toBe('accepted_local_or_hub_changed');
      const tomb:any=f.db.prepare('SELECT body,operation_sha256 FROM sync_content_outbox WHERE deleted=1').get();
      expect((await pushRequest(f.app,f.user,f.device,[tomb])).status).toBe(200);
      const current=await f.app.store.getRepairHead(f.user,f.device,parseCanonicalOperation(f.native).id);
      expect(current.head!.entity_rev).toBe('12'); expect(JSON.parse(current.op!.body).deleted).toBe(true);
    } finally { sync.stop(); f.db.close(); }
  });

  it('keeps the new epoch requeue when an old-epoch repair response arrives', async () => {
    const f=await fixture(); f.db.prepare('UPDATE observations SET synced_at=123 WHERE id=?').run(f.id);
    const config={...f.config,fetch:(async(url:any,init:any)=>{
      const response=await fetch(url,init);
      if(String(url).endsWith('/repair')) new SyncApply(f.db,{deviceId:f.device}).handleEpoch('20');
      return response;
    }) as typeof fetch};
    try {
      const recovery=new SyncConflictRecovery(f.db,config); const preview=await recovery.preview({kind:'observation',originLocalId:f.id,choice:'local_current'});
      expect((await recovery.apply({previewToken:preview.previewToken})).state).toBe('accepted_previous_epoch');
      expect(f.db.prepare('SELECT sync_rev,synced_at FROM observations WHERE id=?').get(f.id)).toEqual({sync_rev:'1',synced_at:null});
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM sync_entity_heads').get()).toEqual({n:0});
      expect(f.db.prepare('SELECT state,acknowledged_seq FROM sync_conflict_repairs').get()).toEqual({state:'accepted_previous_epoch',acknowledged_seq:'2'});
    } finally {f.db.close();}
  });

  it('does not verify matching native bytes when a higher retained head arrives during repair', async () => {
    const f=await fixture('1');
    const config={...f.config,fetch:(async(url:any,init:any)=>{
      const response=await fetch(url,init);
      if(String(url).endsWith('/repair')) {
        const sent=JSON.parse(JSON.parse(init.body).op.body);
        f.db.prepare('UPDATE observations SET sync_rev=? WHERE id=?').run(sent.entity_rev,f.id);
        f.db.prepare(`INSERT INTO sync_entity_heads(entity_id,kind,origin_device_id,origin_local_id,entity_rev,operation_sha256,deleted,updated_at_epoch)
          VALUES(?,'observation',?,?,'9','newer-head',0,1)`).run(sent.id,f.device,f.id);
      }
      return response;
    }) as typeof fetch};
    try {
      const recovery=new SyncConflictRecovery(f.db,config); const preview=await recovery.preview({kind:'observation',originLocalId:f.id,choice:'local_current'});
      expect((await recovery.apply({previewToken:preview.previewToken})).state).toBe('accepted_local_or_hub_changed');
      expect(f.db.prepare('SELECT sync_rev,synced_at FROM observations WHERE id=?').get(f.id)).toEqual({sync_rev:'10',synced_at:null});
      expect(f.db.prepare('SELECT entity_rev FROM sync_entity_heads').get()).toEqual({entity_rev:'9'});
    } finally {f.db.close();}
  });

  it('allocates the next ordinary snapshot above a lost high repair response', async () => {
    const f=await fixture(); let lose=true;
    const config={...f.config,fetch:(async(url:any,init:any)=>{
      const response=await fetch(url,init);
      if(lose&&String(url).endsWith('/repair')) {lose=false;throw Error('lost reply');} return response;
    }) as typeof fetch};
    const sync=new CloudSync(f.db,{CLAUDE_MEM_CLOUD_SYNC_TOKEN:config.authToken,CLAUDE_MEM_CLOUD_SYNC_USER_ID:f.user,
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL:f.app.url,CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:f.device});
    try {
      const recovery=new SyncConflictRecovery(f.db,config); const preview=await recovery.preview({kind:'observation',originLocalId:f.id,choice:'local_current'});
      await expect(recovery.apply({previewToken:preview.previewToken})).rejects.toMatchObject({code:'repair_transport_unavailable'});
      f.db.prepare('UPDATE observations SET narrative=?,sync_rev=?,synced_at=NULL WHERE id=?').run('newer local edit','2',f.id);
      await sync.flush();
      const current=await f.app.store.getRepairHead(f.user,f.device,parseCanonicalOperation(f.native).id);
      expect(current.head!.entity_rev).toBe('12'); expect(JSON.parse(current.op!.body).payload.narrative).toBe('newer local edit');
      expect((await new SyncConflictRecovery(f.db,config).apply({previewToken:preview.previewToken})).state).toBe('accepted_local_or_hub_changed');
      expect((f.db.prepare('SELECT narrative FROM observations WHERE id=?').get(f.id) as any).narrative).toBe('newer local edit');
    } finally {sync.stop();f.db.close();}
  });
});
