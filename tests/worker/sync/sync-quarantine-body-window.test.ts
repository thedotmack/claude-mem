import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildContentOperation, type CanonicalHubChange } from '../../../src/services/sync/CanonicalContent.js';

const epoch = Date.parse('2026-11-01T12:00:00.000Z');
const iso = new Date(epoch).toISOString();
const peer = 'quarantine-peer';
const self = 'quarantine-self';

describe('pull retries do not materialize the whole quarantine backlog', () => {
  let store: SessionStore;
  let apply: SyncApply;
  let seq: number;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    apply = new SyncApply(store.db, { deviceId: self });
    seq = 0;
  });
  afterEach(() => store.close());

  function operation(id: number, rev: number, hash: string, narrative = 'short', deleted = false, device = peer): CanonicalHubChange {
    return { seq: String(++seq), ...buildContentOperation({
      kind: 'observation', originDeviceId: device, originLocalId: String(id), entityRev: String(rev),
      deleted, deletedAt: deleted ? iso : null,
      payload: deleted ? null : {
        memory_session_id: 'quarantine-memory', project: 'quarantine-project',
        type: 'discovery', title: `Observation ${id} revision ${rev}`, narrative,
        facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [],
        content_hash: hash, prompt_number: '1', discovery_tokens: '0',
        created_at: iso, created_at_epoch: String(epoch),
      },
    }) };
  }
  const receive = (changes: CanonicalHubChange[]) => apply.applyOps(decodeChanges(changes), { requireContiguous: true });
  const pending = () => (store.db.query('SELECT count(*) AS n FROM sync_pull_quarantine WHERE retryable = 1').get() as { n: number }).n;
  const observation = (id: number) => store.db.query('SELECT title, sync_rev FROM observations WHERE origin_device_id = ? AND origin_local_id = ?').get(peer, String(id));

  for (const [count, bodyLength] of [[4, 16 * 1024], [24, 64 * 1024]]) {
    it(`reads one body before retrying, with ${count} quarantined ${bodyLength}-character bodies`, () => {
      const bodies = 'body '.repeat(Math.ceil(bodyLength / 5)).slice(0, bodyLength);
      const first: CanonicalHubChange[] = [];
      for (let i = 0; i < count; i++) {
        first.push(operation(100 + i, 1, `original-${i}`));
        first.push(operation(200 + i, 1, `blocked-${i}`));
      }
      expect(receive(first).applied).toBe(count * 2);
      const blocked = Array.from({ length: count }, (_, i) => operation(100 + i, 2, `blocked-${i}`, bodies));
      expect(receive(blocked).quarantined).toBe(count);
      expect(pending()).toBe(count);

      // Observe materialization from real SQLite statements; their SQL and
      // returned rows are untouched. The first retry starts at its savepoint.
      let bodyReads = 0;
      let largestBatch = 0;
      let bodiesAtFirstRetry: number | undefined;
      const record = (value: any) => {
        const rows = Array.isArray(value) ? value : [value];
        const materialized = rows.filter(row => typeof row?.raw_body === 'string').length;
        bodyReads += materialized;
        largestBatch = Math.max(largestBatch, materialized);
        return value;
      };
      const prepare = store.db.prepare.bind(store.db);
      const run = store.db.run.bind(store.db);
      const prepareSpy = spyOn(store.db, 'prepare').mockImplementation(((sql: string, ...args: any[]) => {
        const statement = (prepare as any)(sql, ...args);
        if (/SELECT[\s\S]*FROM sync_pull_quarantine/i.test(sql)) {
          const all = statement.all.bind(statement);
          const get = statement.get.bind(statement);
          statement.all = (...params: any[]) => record(all(...params));
          statement.get = (...params: any[]) => record(get(...params));
        }
        return statement;
      }) as any);
      const runSpy = spyOn(store.db, 'run').mockImplementation(((sql: string, ...args: any[]) => {
        if (sql === 'SAVEPOINT sync_apply_op' && bodiesAtFirstRetry === undefined) bodiesAtFirstRetry = bodyReads;
        return (run as any)(sql, ...args);
      }) as any);
      try {
        // A real subsequent page triggers retries; an own-device op has no
        // row application before the retry lane starts.
        expect(receive([operation(9999, 1, 'own', 'own', false, self)]).skippedOwn).toBe(1);
      } finally {
        runSpy.mockRestore();
        prepareSpy.mockRestore();
      }
      expect(bodiesAtFirstRetry).toBe(1);
      expect(largestBatch).toBe(1);
      expect(bodyReads).toBe(count);
      expect(pending()).toBe(count);

      // Resolve different entries in successive pages while leaving the rest
      // blocked: delete a blocker, supersede a revision, and tombstone a target.
      receive([operation(200, 2, '', '', true)]);
      expect(observation(100)).toEqual({ title: 'Observation 100 revision 2', sync_rev: '2' });
      expect(pending()).toBe(count - 1);
      receive([operation(101, 3, 'newer-101')]);
      expect(observation(101)).toEqual({ title: 'Observation 101 revision 3', sync_rev: '3' });
      expect(pending()).toBe(count - 2);
      receive([operation(102, 3, '', '', true)]);
      expect(observation(102)).toBeNull();
      expect(pending()).toBe(count - 3);
      expect(observation(103)).toEqual({ title: 'Observation 103 revision 1', sync_rev: '1' });
      expect(apply.getCursor()).toBe(String(seq));
    });
  }
});
