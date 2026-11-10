import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncRecoveryReader } from '../../../src/services/sync/SyncRecoveryReader.js';
import { initializeConflictRecoverySchema, SyncConflictRecovery } from '../../../src/services/sync/SyncConflictRecovery.js';
import { readLocalConflictEvidence, MAX_CONFLICT_EVIDENCE_ROWS } from '../../../src/services/sync/SyncConflictEvidence.js';
import { getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const flags = { deviceId: 'packaged-recovery', sharedWorkWritesEnabled: false, workStateSupported: true };

it('closes pending reads, refuses unavailable memory databases, and never opens a missing file for creation', async () => {
  const memory = new SyncRecoveryReader(':memory:', flags.deviceId, () => flags);
  await expect(memory.inventory()).rejects.toThrow('unavailable'); memory.close();
  const dir = mkdtempSync(join(tmpdir(), 'recovery-missing-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const reader = new SyncRecoveryReader(join(dir, 'absent.db'), flags.deviceId, () => flags);
  const read = reader.inventory(); reader.close();
  await expect(read).rejects.toThrow('unavailable');
  expect(await Bun.file(join(dir, 'absent.db')).exists()).toBe(false);
});

it('reads retained conflict metadata without materializing frozen bodies and refuses oversized evidence', () => {
  const db = new Database(':memory:');
  try {
    const store = new SessionStore(db); initializeConflictRecoverySchema(db);
    db.run("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES('s','m','p','2026-01-01T00:00:00Z',1767225600000,'active')");
    const id = String(store.storeObservation('m','p',{type:'discovery',title:'source',subtitle:null,facts:[],narrative:'x'.repeat(100000),concepts:[],files_read:[],files_modified:[]},1,0).id);
    const op = getNativeContentOperation(db,'observation',id,flags.deviceId)!.operation;
    const entityId = JSON.parse(op.body).id;
    const insert = db.prepare("INSERT INTO sync_content_outbox(entity_id,kind,origin_local_id,entity_rev,body,operation_sha256,deleted,created_at_epoch) VALUES(?,'observation',?,?,?,?,0,1)");
    db.transaction(() => { for (let rev = 2; rev <= 401; rev++) {
      const frozen = getNativeContentOperation(db,'observation',id,flags.deviceId,String(rev))!.operation;
      insert.run(entityId,id,String(rev),frozen.body,frozen.operation_sha256);
    } })();
    expect(() => readLocalConflictEvidence(db,flags.deviceId,'observation',id)).toThrow('repair_evidence_too_large');
    const evidence = readLocalConflictEvidence(db,flags.deviceId,'observation',id,{validateBodies:false});
    expect(evidence.outbox).toHaveLength(400);
    expect(evidence.outbox.every(item => !Object.hasOwn(item,'body'))).toBe(true);
    expect(JSON.stringify(evidence.outbox).length).toBeLessThan(100000);
    db.exec('DELETE FROM sync_content_outbox');
    insert.run(entityId,id,'1',op.body,op.operation_sha256);
    const beforeCorruption = readLocalConflictEvidence(db,flags.deviceId,'observation',id,{validateBodies:false}).digest;
    db.prepare("UPDATE sync_content_outbox SET body='corrupt' WHERE entity_id=?").run(entityId);
    expect(readLocalConflictEvidence(db,flags.deviceId,'observation',id,{validateBodies:false}).digest).not.toBe(beforeCorruption);
    expect(() => readLocalConflictEvidence(db,flags.deviceId,'observation',id)).toThrow('repair_evidence_corrupt');
    const quarantine = db.prepare("INSERT INTO sync_pull_quarantine(epoch,seq,entity_id,entity_rev,reason,raw_body,created_at_epoch) VALUES('1',?,?,'1','retained','private',1)");
    db.transaction(() => { for (let seq = 0; seq <= MAX_CONFLICT_EVIDENCE_ROWS; seq++) quarantine.run(String(seq),entityId); })();
    expect(() => readLocalConflictEvidence(db,flags.deviceId,'observation',id)).toThrow('repair_evidence_too_large');
  } finally { db.close(); }
});

it('runs conflict investigation off HTTP while its read-only SQLite connection is blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(),'conflict-reader-'));
  cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const databasePath = join(dir,'source.db'); const db = new Database(databasePath);
  cleanup.push(() => { if(db.inTransaction)db.exec('ROLLBACK'); db.close(); });
  const store = new SessionStore(db); initializeConflictRecoverySchema(db);
  db.run("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES('s','m','p','2026-01-01T00:00:00Z',1767225600000,'active')");
  const id = String(store.storeObservation('m','p',{type:'discovery',title:'source',subtitle:null,facts:[],narrative:'private',concepts:[],files_read:[],files_modified:[]},1,0).id);
  db.exec('PRAGMA journal_mode=DELETE');
  const reader = new SyncRecoveryReader(databasePath,flags.deviceId,()=>flags); cleanup.push(()=>reader.close());
  await reader.conflictEvidence('observation',id);
  const service = new SyncConflictRecovery(db,{deviceId:flags.deviceId,userId:'fixture',authToken:'fixture',hubUrl:'https://fixture.invalid',
    readEvidence:(kind,id)=>reader.conflictEvidence(kind,id), listEvidence:limit=>reader.conflicts(limit),
    fetch: (async (_url,init)=>Response.json({protocol_version:1,capability:'origin-repair-v1',epoch:'1',entity_id:JSON.parse(String(init?.body)).entity_id,head_seq:'0',projected_seq:'0',head:null,op:null})) as typeof fetch });
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({ok:true})}); cleanup.push(()=>server.stop(true));
  db.exec('BEGIN EXCLUSIVE');
  let completed = false; const preview = service.preview({kind:'observation',originLocalId:id,choice:'local_current'}).then(value=>{completed=true;return value;});
  await Bun.sleep(50);
  expect((await fetch(`http://127.0.0.1:${server.port}`,{signal:AbortSignal.timeout(1000)})).ok).toBe(true);
  expect(completed).toBe(false);
  db.exec('ROLLBACK'); expect((await preview).authority).toBe('local_origin');
},10000);
