import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { ensureSyncRecoverySchema, SyncRecovery, type RecoveryScope } from '../../../src/services/sync/SyncRecovery.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';

const NOW = Date.parse('2026-07-01T00:00:00Z');
const SCOPE: RecoveryScope = { project: 'test', from: '2026-01-01', to: '2027-01-01', kinds: ['observation'] };
const DEVICE = 'fixture-native';

describe('selected historical recovery', () => {
  let db: Database; let store: SessionStore; let sync: CloudSync; let recovery: SyncRecovery;
  let pages: any[][]; let reject = false; let onPush: (() => Promise<void>) | null; let nextTitle = 0;
  let supportedKinds: string[]; let statusCalls: number;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/status')) { statusCalls++; return Response.json({ protocol_version: 2, epoch: '1', head_seq: '0', projected_seq: '0', content_kinds: supportedKinds }); }
    const { ops } = JSON.parse(String(init?.body)); pages.push(ops);
    await onPush?.();
    if (reject) return new Response('retry', { status: 503 });
    const acked = ops.map((op: any, index: number) => { const body = JSON.parse(op.body); return { id: body.id, kind: body.kind, origin_local_id: body.origin_local_id, entity_rev: body.entity_rev, operation_sha256: op.operation_sha256, seq: String(index + 1) }; });
    return Response.json({ acked, head_seq: String(ops.length), projected_seq: String(ops.length) });
  }) as typeof fetch;
  function makeSync() {
    return new CloudSync(db, { CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'fixture', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'fixture', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://fixture.invalid', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEVICE, CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'fixture' },
      { fetchImpl, contentBatchSize: 2, backoffInitialMs: 600000, backoffMaxMs: 600000 });
  }
  beforeEach(() => {
    db = new Database(':memory:'); store = new SessionStore(db); pages = []; reject = false; onPush = null; nextTitle = 0;
    supportedKinds = ['observation', 'summary', 'prompt', 'work_state']; statusCalls = 0;
    db.prepare("INSERT INTO sync_state(k,v) VALUES ('epoch','1')").run();
    db.prepare("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES ('content','memory','test','2026-07-01T00:00:00Z',?,'active')").run(NOW);
    sync = makeSync(); recovery = sync.recovery;
  });
  afterEach(() => { sync.stop(); db.close(); });
  function historical(project = 'test', revision = '1') {
    const id = store.storeObservation('memory', project, { type: 'discovery', title: `private title ${++nextTitle}`, subtitle: null, narrative: 'private body', facts: [], concepts: [], files_read: [], files_modified: [] }, 1, 0).id;
    db.prepare('UPDATE observations SET created_at_epoch = ?, synced_at = ?, sync_rev = ? WHERE id = ?').run(NOW, NOW, revision, id);
    db.prepare("INSERT INTO sync_launch_exclusions(kind,origin_local_id,through_rev) VALUES ('observation',?,?)").run(String(id), revision);
    return String(id);
  }
  function create() { const preview = recovery.preview(SCOPE); return recovery.create({ scope: SCOPE, previewToken: preview.previewToken }); }
  function historicalWorkState(listName = 'release') {
    const id = String(store.appendWorkStateEntry({ project: 'test', listName, fields: { task: 'publish' }, createdAtEpoch: NOW }));
    db.prepare('UPDATE work_state_entries SET synced_at = ? WHERE id = ?').run(NOW, id);
    db.prepare("INSERT INTO sync_launch_exclusions(kind,origin_local_id,through_rev) VALUES ('work_state',?,'1')").run(id);
    return id;
  }
  function resume(id: string) { recovery.transition(id, 'resume', '1'); }
  function state(id: string) { return recovery.get(id) as any; }
  it('preview and inventory write nothing, upload nothing, expose no content, and distinguish extant/ledger/conflicts', () => {
    historical(); historical('other');
    db.prepare("INSERT INTO sync_launch_exclusions(kind,origin_local_id,through_rev) VALUES ('observation','999','1')").run();
    for (const seq of ['1', '2']) db.prepare("INSERT INTO sync_pull_quarantine(epoch,seq,kind,entity_id,reason,raw_body,created_at_epoch) VALUES ('1',?,'observation','same-entity','safe','{}',?)").run(seq, NOW);
    const changes = (db.query('SELECT total_changes() AS n').get() as any).n;
    const preview = recovery.preview(SCOPE); const inventory = recovery.inventory();
    expect(preview.count).toBe(1); expect(preview.estimatedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(preview)).not.toContain('private'); expect(pages.length).toBe(0);
    expect((db.query('SELECT total_changes() AS n').get() as any).n).toBe(changes);
    expect(inventory.excludedCurrent.observation).toBe(2); expect(inventory.ledgerEntries.observation).toBe(3);
    expect(inventory.quarantine.pullOperations).toBe(2); expect(inventory.quarantine.pullDistinctEntities).toBe(1);
  });
  it('requires explicit bounded scope and an exact fresh preview before creating a paused idempotent job', () => {
    const id = historical(); historical();
    expect(() => recovery.preview({ ...SCOPE, maxItems: 1 })).toThrow('narrow');
    expect(() => recovery.preview({ ...SCOPE, kinds: [] })).toThrow('Explicit');
    const preview = recovery.preview(SCOPE); db.prepare('UPDATE observations SET title = ? WHERE id = ?').run('edited', id);
    expect(() => recovery.create({ scope: SCOPE, previewToken: preview.previewToken })).toThrow('stale');
    const job = create(); expect(job.status).toBe('paused'); expect(create().id).toBe(job.id); expect(pages.length).toBe(0);
  });
  it('revalidates bounded worker-preview members before committing and never expands that snapshot', () => {
    const id = historical(); const preview = recovery.preview(SCOPE);
    historical(); // arriving after the concrete preview stays outside its manifest
    const job = recovery.createFromPreview(preview, preview.previewToken); expect(job.items.length).toBe(1);
    const next = recovery.preview(SCOPE);
    db.prepare("UPDATE observations SET title = 'changed after worker preview' WHERE id = ?").run(id);
    expect(() => recovery.createFromPreview(next, next.previewToken)).toThrow('stale');
  });
  it('rechecks a changed native revision between selection and atomic enqueue', async () => {
    const id = historical(); const job = create(); resume(job.id);
    const select = recovery.selectPage.bind(recovery);
    recovery.selectPage = limit => { const result = select(limit); db.prepare("UPDATE observations SET title = 'newer', sync_rev = '2', synced_at = NULL WHERE id = ?").run(id); return result; };
    await sync.flush(); expect(pages.length).toBe(0); expect(state(job.id).items[0].status).toBe('superseded');
    recovery.selectPage = select; await sync.flush(); expect(JSON.parse(pages[0][0].body).entity_rev).toBe('2');
  });
  it('arms the next pass when a whole page is skipped and selected items remain', async () => {
    const first = historical(); const second = historical(); const third = historical();
    const job = create(); resume(String(job.id));
    db.prepare("UPDATE observations SET title = 'newer', sync_rev = '2', synced_at = ? WHERE id IN (?, ?)").run(NOW, first, second);
    const armedDelays: number[] = []; (sync as any).armFlushTimer = (delayMs: number) => { armedDelays.push(delayMs); };
    await sync.flush();
    expect(pages.flat().map((op: any) => JSON.parse(op.body).origin_local_id)).not.toContain(third);
    expect(state(String(job.id)).status).toBe('running');
    expect(armedDelays).toContain(1000);
    await sync.flush();
    expect(pages.flat().map((op: any) => JSON.parse(op.body).origin_local_id)).toContain(third);
    expect(state(String(job.id)).status).toBe('complete');
  });
  it('does not arm a pass when nothing selected can move', async () => {
    historical(); const job = create(); resume(String(job.id));
    (sync as any).hubAcceptsKind = () => false;
    const armedDelays: number[] = []; (sync as any).armFlushTimer = (delayMs: number) => { armedDelays.push(delayMs); };
    await sync.flush();
    expect(pages.length).toBe(0); expect(state(String(job.id)).status).toBe('running'); expect(armedDelays).not.toContain(1000);
  });
  it('reports malformed selected content as a safe terminal failure without uploading it', async () => {
    const id = historical(); const job = create(); resume(job.id);
    db.prepare("UPDATE observations SET facts = 'private malformed details' WHERE id = ?").run(id);
    await sync.flush(); expect(pages.length).toBe(0);
    expect(state(job.id).status).toBe('complete'); expect(state(job.id).items[0].status).toBe('failed');
    expect(JSON.stringify(state(job.id))).not.toContain('private malformed');
  });
  it('sends at most one idle background page per flush and acknowledges through the ordinary durable path', async () => {
    historical(); historical(); historical();
    const job = create(); resume(String(job.id));
    await sync.flush(); expect(pages.flat().length).toBe(2);
    expect(state(String(job.id)).items.map((x: any) => x.status).sort()).toEqual(['acknowledged', 'acknowledged', 'selected']);
    await sync.flush(); expect(pages.flat().length).toBe(3); expect(state(String(job.id)).status).toBe('complete');
    expect((db.query('SELECT COUNT(*) n FROM sync_launch_exclusions').get() as any).n).toBe(3);
  });
  it('restart at selection, queued upload, and ack boundaries retains exact operations and progress', async () => {
    historical(); const job = create(); resume(String(job.id));
    expect(recovery.selectPage(2).length).toBe(1); // crash before snapshot changes no eligibility
    reject = true; await sync.flush(); const first = pages[0][0]; expect(state(String(job.id)).items[0].status).toBe('queued');
    sync.stop(); sync = makeSync(); recovery = sync.recovery; reject = false;
    await sync.flush(); expect(pages[1][0]).toEqual(first); expect(state(String(job.id)).status).toBe('complete');
    sync.stop(); sync = makeSync(); recovery = sync.recovery; await sync.flush(); expect(pages.length).toBe(2);
    expect((db.query('SELECT COUNT(*) n FROM sync_recovery_receipts').get() as any).n).toBe(1);
  });
  it('rolls back admission if its manifest receipt fails after enqueue, then safely restarts', async () => {
    historical(); const job = create(); resume(job.id);
    const record = recovery.recordSnapshot.bind(recovery);
    recovery.recordSnapshot = () => { throw new Error('simulated crash between enqueue and receipt'); };
    await sync.flush();
    expect((db.query('SELECT COUNT(*) n FROM sync_content_outbox').get() as any).n).toBe(0);
    expect(state(job.id).items[0].status).toBe('selected'); expect(pages.length).toBe(0);
    recovery.recordSnapshot = record; await sync.flush(); expect(state(job.id).status).toBe('complete');
  });
  it('does not call an old-epoch in-flight acknowledgement current, and resumes the preserved selection explicitly', async () => {
    historical(); const job = create(); resume(job.id);
    onPush = async () => { db.prepare("UPDATE sync_state SET v = '2' WHERE k = 'epoch'").run(); };
    await sync.flush();
    expect(state(job.id).status).toBe('paused'); expect(state(job.id).items[0].status).toBe('queued');
    expect(state(job.id).items[0].acknowledged_epoch).toBeNull();
    expect((db.query('SELECT event FROM sync_recovery_receipts').get() as any).event).toBe('acknowledged_epoch_unverified');
    onPush = null; recovery.transition(job.id, 'resume', '2'); await sync.flush();
    expect(state(job.id).items[0].acknowledged_epoch).toBe('2'); expect(state(job.id).status).toBe('complete');
  });
  it('continues a selected job on an idle device through the same live-first flush timer', async () => {
    historical(); historical(); historical(); const job = create(); resume(job.id);
    const armedDelays: number[] = []; (sync as any).armFlushTimer = (delayMs: number) => { armedDelays.push(delayMs); };
    await sync.flush(); expect(state(job.id).status).toBe('running');
    expect(armedDelays).toContain(1000);
    await sync.flush();
    expect(state(job.id).status).toBe('complete'); expect(pages.length).toBe(2);
  });
  it('pause prevents selection while cancel during an in-flight upload preserves the real acknowledgement', async () => {
    historical(); const job = create(); resume(String(job.id)); recovery.transition(String(job.id), 'pause', null);
    await sync.flush(); expect(pages.length).toBe(0); resume(String(job.id));
    let release!: () => void; let entered!: () => void; const arrived = new Promise<void>(resolve => { entered = resolve; });
    onPush = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const flush = sync.flush(); await arrived;
    recovery.transition(String(job.id), 'cancel', null); release(); await flush;
    expect(state(String(job.id)).status).toBe('cancelled'); expect(state(String(job.id)).items[0].status).toBe('acknowledged');
    expect(() => resume(String(job.id))).toThrow('Cancelled');
  });
  it('new local edits supersede selected history, and deleted selection cannot resurrect content', async () => {
    const edited = historical(); const deleted = historical(); const job = create(); resume(String(job.id));
    db.prepare("UPDATE observations SET title = 'newer', sync_rev = '2', synced_at = NULL WHERE id = ?").run(edited);
    sync.queueDelete('observation', deleted);
    await sync.flush();
    const items = state(String(job.id)).items; expect(items.find((x: any) => x.origin_local_id === edited).status).toBe('superseded');
    expect(items.find((x: any) => x.origin_local_id === deleted).status).toBe('deleted');
    expect(pages.flat().map((op: any) => JSON.parse(op.body)).every(body => body.deleted || body.entity_rev === '2')).toBe(true);
    expect(db.prepare('SELECT id FROM observations WHERE id = ?').get(deleted)).toBeNull();
  });
  it('uses canonical decimal revisions above Number precision and respects a higher existing head', async () => {
    const id = historical('test', '9007199254740993'); const op = getNativeContentOperation(db, 'observation', id, DEVICE)!.operation;
    const body = JSON.parse(op.body);
    db.prepare("INSERT INTO sync_entity_heads(entity_id,kind,origin_device_id,origin_local_id,entity_rev,operation_sha256,deleted,updated_at_epoch) VALUES (?,'observation',?,?,'9007199254740995','different',0,?)").run(body.id, DEVICE, id, NOW);
    const job = create(); resume(String(job.id)); await sync.flush();
    expect(JSON.parse(pages[0][0].body).entity_rev).toBe('9007199254740996');
    expect(state(String(job.id)).items[0].queued_rev).toBe('9007199254740996');
  });
  it('epoch changes pause selection, preserve baseline and receipts, and require the exact current epoch to resume', async () => {
    historical(); const job = create(); resume(String(job.id));
    db.prepare("UPDATE sync_state SET v = '2' WHERE k = 'epoch'").run(); await sync.flush();
    expect(pages.length).toBe(0); expect(state(String(job.id)).pause_reason).toBe('epoch_changed');
    expect(() => recovery.transition(String(job.id), 'resume', '1')).toThrow('epoch changed');
    recovery.transition(String(job.id), 'resume', '2'); await sync.flush(); expect(state(String(job.id)).items[0].acknowledged_epoch).toBe('2');
    expect((db.query('SELECT COUNT(*) n FROM sync_launch_exclusions').get() as any).n).toBe(1);
  });
  it('replays acknowledged history after repeated pause across a real epoch transition', async () => {
    historical(); const job = create(); resume(job.id); await sync.flush();
    expect(state(job.id).items[0].acknowledged_epoch).toBe('1');
    recovery.transition(job.id, 'pause', null);
    new SyncApply(db, { deviceId: DEVICE }).handleEpoch('2');
    recovery.transition(job.id, 'pause', null);
    expect(state(job.id).epoch).toBe('1'); // pause does not rewrite evidence
    recovery.transition(job.id, 'resume', '2');
    expect(state(job.id).items[0].status).toBe('selected');
    await sync.flush();
    expect(pages.flat().length).toBe(2); expect(state(job.id).items[0].acknowledged_epoch).toBe('2');
    expect((db.query('SELECT epoch FROM sync_recovery_receipts ORDER BY id').all() as any[]).map(row => row.epoch)).toEqual(['1', '2']);
  });
  it('cancel preserves the original job and item proof epochs after an epoch transition', async () => {
    historical(); const job = create(); resume(job.id); await sync.flush();
    new SyncApply(db, { deviceId: DEVICE }).handleEpoch('2');
    recovery.transition(job.id, 'cancel', null);
    expect(state(job.id).epoch).toBe('1'); expect(state(job.id).items[0].acknowledged_epoch).toBe('1');
    expect(() => recovery.transition(job.id, 'resume', '2')).toThrow('Cancelled');
  });
  it('resume revalidates each queued or acknowledged epoch even if an older version overwrote the job epoch', async () => {
    historical(); const job = create(); resume(job.id); reject = true; await sync.flush();
    expect(state(job.id).items[0].queued_epoch).toBe('1');
    new SyncApply(db, { deviceId: DEVICE }).handleEpoch('2');
    db.prepare("UPDATE sync_recovery_jobs SET epoch = '2', status = 'paused' WHERE id = ?").run(job.id);
    recovery.transition(job.id, 'resume', '2');
    expect(state(job.id).items[0].status).toBe('selected'); expect(state(job.id).items[0].queued_epoch).toBeNull();
    reject = false; await sync.flush(); expect(state(job.id).items[0].acknowledged_epoch).toBe('2');
    new SyncApply(db, { deviceId: DEVICE }).handleEpoch('3');
    db.prepare("UPDATE sync_recovery_jobs SET epoch = '3', status = 'paused' WHERE id = ?").run(job.id);
    recovery.transition(job.id, 'resume', '3');
    expect(state(job.id).items[0].status).toBe('selected');
    await sync.flush(); expect(state(job.id).items[0].acknowledged_epoch).toBe('3');
  });
  it('migrates older queued receipts with unknown epoch without treating them as current proof', async () => {
    historical(); const job = create(); resume(job.id); reject = true; await sync.flush();
    db.run('ALTER TABLE sync_recovery_items DROP COLUMN queued_epoch');
    ensureSyncRecoverySchema(db); ensureSyncRecoverySchema(db);
    expect(state(job.id).items[0].queued_epoch).toBeNull();
    recovery.transition(job.id, 'resume', '1'); expect(state(job.id).items[0].status).toBe('selected');
    reject = false; await sync.flush();
    expect(state(job.id).items[0].queued_epoch).toBe('1'); expect(state(job.id).items[0].acknowledged_epoch).toBe('1');
  });
  it('discovers capabilities and uploads selected historical work-state after restart', async () => {
    historicalWorkState(); await sync.statusWithHubProbe();
    const scope: RecoveryScope = { ...SCOPE, kinds: ['work_state'] };
    const preview = recovery.preview(scope); const job = recovery.create({ scope, previewToken: preview.previewToken }); resume(job.id);
    sync.stop(); sync = makeSync(); recovery = sync.recovery; statusCalls = 0;
    await sync.flush();
    expect(statusCalls).toBe(1); expect(pages.flat().map(op => JSON.parse(op.body).kind)).toEqual(['work_state']);
    expect(state(job.id).status).toBe('complete');
  });
  it('held historical work-state does not consume the page budget ahead of another eligible job', async () => {
    historicalWorkState(); historicalWorkState('next'); await sync.statusWithHubProbe();
    const scope: RecoveryScope = { ...SCOPE, kinds: ['work_state'] };
    const preview = recovery.preview(scope); const held = recovery.create({ scope, previewToken: preview.previewToken }); resume(held.id);
    historical(); const eligible = create(); resume(eligible.id);
    supportedKinds = ['observation', 'summary', 'prompt']; sync.stop(); sync = makeSync(); recovery = sync.recovery; statusCalls = 0;
    await sync.flush();
    expect(statusCalls).toBe(1); expect(pages.flat().map(op => JSON.parse(op.body).kind)).toEqual(['observation']);
    expect(state(held.id).items.every((item: any) => item.status === 'selected')).toBe(true);
    expect(state(eligible.id).status).toBe('complete');
  });
  it('rejects a foreign device job and does not select another project', () => {
    historical(); historical('other'); const job = create();
    const foreign = new SyncRecovery(db, 'foreign', { snapshotNative: () => null, flags: () => ({ deviceId: 'foreign', sharedWorkWritesEnabled: false, workStateSupported: false }) });
    expect(() => foreign.get(String(job.id))).toThrow('not found'); expect(foreign.selectPage(2)).toEqual([]);
    expect((job.items as unknown[]).length).toBe(1);
  });
  it('refuses a 101st active job rather than silently starving beyond the bounded scheduler scan', () => {
    historical(); const job = create();
    const insert = db.prepare("INSERT INTO sync_recovery_jobs(id,preview_token,device_id,scope_json,epoch,status,created_at_epoch,updated_at_epoch) VALUES (?,?,?,'{}','1','running',?,?)");
    for (let i = 0; i < 100; i++) insert.run(`fixture-${i}`, `token-${i}`, DEVICE, NOW + i, NOW);
    expect(() => resume(job.id)).toThrow('maximum 100 active jobs'); expect(state(job.id).status).toBe('paused');
  });
});
