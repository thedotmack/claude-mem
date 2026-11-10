import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MemoryFeedInvalidation } from '../../../../src/services/worker/MemoryFeedInvalidation.js';
import { emitContextInvalidation } from '../../../../src/shared/context-invalidation.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../../src/services/sync/SyncClient.js';
import { buildContentOperation, buildMutationOperation, parseCanonicalOperation } from '../../../../src/services/sync/CanonicalContent.js';
import { observationChange } from '../../sync/content-v2-helpers.js';

const bridges: MemoryFeedInvalidation[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const database of databases.splice(0)) database.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
function bridgeFor(broadcast: (event: Record<string, unknown>) => void) {
  const bridge = new MemoryFeedInvalidation({ broadcast }, 1);
  bridges.push(bridge);
  bridge.start();
  return bridge;
}

describe('committed memory feed invalidation', () => {
  it('coalesces known content kinds and projects without changing global listeners on restart', async () => {
    const events: Record<string, unknown>[] = [];
    const bridge = bridgeFor(event => events.push(event));
    bridge.start();
    emitContextInvalidation({ projects: ['beta'] }, 'storeObservations');
    emitContextInvalidation({ projects: ['alpha', 'beta'] }, 'storeSummary');
    emitContextInvalidation({ projects: ['alpha'] }, 'native-prompt', 'additive', { kinds: ['prompt'] });
    await tick();
    expect(events).toEqual([{ type: 'data_changed', kinds: ['observation', 'prompt', 'summary'], projects: ['alpha', 'beta'] }]);
  });

  it('does not turn health, settings, or work-state-only writes into memory refreshes', async () => {
    const events: Record<string, unknown>[] = [];
    bridgeFor(event => events.push(event));
    for (const reason of ['settings', 'sync-health', 'observer-health', 'unrelated', 'constructor']) emitContextInvalidation('all', reason);
    emitContextInvalidation('all', 'SyncApply.applyOps', 'additive', { kinds: ['work_state'], workStateLists: ['tasks'] });
    emitContextInvalidation('all', 'SyncApply.replaySetAsideWorkState');
    emitContextInvalidation('all', 'appendWorkStateEntry', 'additive', { kinds: ['work_state'] });
    await tick();
    expect(events).toEqual([]);
  });

  it('widens mutations, unknown remote recovery, and project moves to an authoritative refresh', async () => {
    const events: Record<string, unknown>[] = [];
    bridgeFor(event => events.push(event));
    emitContextInvalidation({ projects: ['old'] }, 'SyncApply.applyOps', 'removal', { kinds: ['mutation'] });
    emitContextInvalidation('all', 'SyncApply.applyOps');
    emitContextInvalidation('all', 'worktree-adoption');
    await tick();
    expect(events).toEqual([{ type: 'data_changed' }]);
  });

  it('refreshes the deleted row kind, and all kinds after session deletion or bulk import', async () => {
    const events: Record<string, unknown>[] = [];
    bridgeFor(event => events.push(event));
    emitContextInvalidation('all', 'delete-observation', 'removal');
    await tick();
    expect(events.shift()).toEqual({ type: 'data_changed', kinds: ['observation'] });
    emitContextInvalidation('all', 'delete-session', 'removal');
    emitContextInvalidation('all', 'project-merge', 'removal');
    emitContextInvalidation('all', 'import', 'removal');
    await tick();
    expect(events).toEqual([{ type: 'data_changed' }]);
  });

  it('bounds the merged project set and clears pending work on shutdown', async () => {
    const events: Record<string, unknown>[] = [];
    const bridge = bridgeFor(event => events.push(event));
    emitContextInvalidation({ projects: Array.from({ length: 140 }, (_, index) => `project-${index}`) }, 'storeSummary');
    await tick();
    expect(events).toEqual([{ type: 'data_changed', kinds: ['summary'] }]);
    emitContextInvalidation('all', 'storeObservations');
    bridge.close();
    bridge.start();
    emitContextInvalidation('all', 'storeSummary');
    await tick();
    expect(events).toHaveLength(1);
  });

  it('keeps committed writes successful even when the viewer broadcaster fails', async () => {
    bridgeFor(() => { throw new Error('fixture broadcaster unavailable'); });
    expect(() => emitContextInvalidation('all', 'storeObservations')).not.toThrow();
    await tick();
  });

  it('publishes only after a real canonical apply page commits, never after a failed page', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    new SessionStore(db);
    const apply = new SyncApply(db, { deviceId: 'local-fixture', chromaSync: null });
    const events: Array<{ event: Record<string, unknown>; inTransaction: boolean; count: number }> = [];
    bridgeFor(event => events.push({
      event, inTransaction: db.inTransaction,
      count: (db.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n,
    }));
    expect(() => apply.applyOps(decodeChanges([observationChange(1, '100'), observationChange(3, '102')]), { requireContiguous: true })).toThrow('sequence gap');
    await tick();
    expect(events).toEqual([]);
    expect(apply.getCursor()).toBe('0');
    apply.applyOps(decodeChanges([observationChange(1, '100'), observationChange(2, '101')]), { requireContiguous: true });
    expect(events).toEqual([]);
    await tick();
    expect(events).toEqual([{ event: { type: 'data_changed', kinds: ['observation'] }, inTransaction: false, count: 2 }]);
  });

  it('announces canonical edits, title changes, remaps and tombstones from their committed state', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    new SessionStore(db);
    const apply = new SyncApply(db, { deviceId: 'local-fixture', chromaSync: null });
    const first = observationChange(1, '100');
    const payload = parseCanonicalOperation({ body: first.body, operation_sha256: first.operation_sha256 }).payload!;
    const events: Record<string, unknown>[] = [];
    bridgeFor(event => events.push(event));
    apply.applyOps(decodeChanges([first]));
    await tick();
    events.length = 0;
    const update = buildContentOperation({ kind: 'observation', originDeviceId: 'device-a', originLocalId: '100', entityRev: '2', payload: { ...payload, title: 'Edited remotely' } });
    const title = buildMutationOperation({ originDeviceId: 'device-a', entityRev: '1', mutation: { op: 'set_title', target: { memory_session_id: 'mem-remote-1' }, fields: { custom_title: 'Renamed remotely' } } });
    const move = buildMutationOperation({ originDeviceId: 'device-a', entityRev: '3', mutation: { op: 'remap_project', where: { memory_session_id: 'mem-remote-1' }, fields: { project: 'moved-project' } } });
    apply.applyOps(decodeChanges([update, title, move].map((op, index) => ({ ...op, seq: String(index + 2), server_ts: '1751328000010' }))));
    await tick();
    expect(events).toEqual([{ type: 'data_changed' }]);
    expect(db.query("SELECT title, project FROM observations WHERE origin_local_id = '100'").get()).toEqual({ title: 'Edited remotely', project: 'moved-project' });
    expect(db.query("SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'").get()).toEqual({ custom_title: 'Renamed remotely' });
    events.length = 0;
    const tombstone = buildContentOperation({ kind: 'observation', originDeviceId: 'device-a', originLocalId: '100', entityRev: '4', payload: null, deleted: true, deletedAt: '2026-11-04T00:00:00.000Z' });
    apply.applyOps(decodeChanges([{ ...tombstone, seq: '5', server_ts: '1751328000011' }]));
    await tick();
    expect(events).toEqual([{ type: 'data_changed', kinds: ['observation'] }]);
    expect(db.query("SELECT id FROM observations WHERE origin_local_id = '100'").get()).toBeNull();
  });

});
