import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply, type ChromaSyncLike, type SyncOp } from '../../../src/services/sync/SyncApply.js';

type IndexedKind = 'observation' | 'summary' | 'prompt';
const TABLES = { observation: 'observations', summary: 'session_summaries', prompt: 'user_prompts' };
const DOC_TYPES = { observation: 'observation', summary: 'session_summary', prompt: 'user_prompt' };
const NOW = 1_750_000_000_000;

function op(seq: number, kind: IndexedKind, originId = '800', deleted = false): SyncOp {
  const common = { memory_session_id: 'remote-memory', project: 'remote-project', created_at_epoch: NOW, prompt_number: 1 };
  const body = kind === 'observation' ? { ...common, type: 'discovery', title: 'Remote title', narrative: 'Remote memory' }
    : kind === 'summary' ? { ...common, request: 'Remote request', completed: 'Remote completion' }
    : { ...common, content_session_id: 'remote-session', prompt_text: 'Remote prompt', platform_source: 'claude' };
  const rev = deleted ? '2' : '1';
  return {
    seq: String(seq), kind, origin_device: 'remote-device', origin_id: originId,
    rev, body: deleted ? 'null' : JSON.stringify(body), server_ts: NOW,
    entity_id: `${kind}:remote-device:${originId}`, entity_rev: rev,
    operation_sha256: (deleted ? 'b' : 'a').repeat(64), deleted,
  };
}

function fixture(options: { waitForWrite?: Promise<void>; failDelete?: number } = {}) {
  const store = new SessionStore(':memory:');
  const docs = new Set<string>();
  const deletions: Array<[string, number]> = [];
  let writing = false;
  let deletesRemainingToFail = options.failDelete ?? 0;
  const write = async (kind: IndexedKind, id: number) => {
    writing = true;
    await options.waitForWrite;
    docs.add(`${DOC_TYPES[kind]}:${id}`);
  };
  const chroma = {
    syncObservation: async (id: number) => write('observation', id),
    syncSummary: async (id: number) => write('summary', id),
    syncUserPrompt: async (id: number) => write('prompt', id),
    deleteRowDocuments: async (docType: string, id: number) => {
      const kind = (Object.keys(DOC_TYPES) as IndexedKind[]).find(key => DOC_TYPES[key] === docType)!;
      assert.equal(store.db.query(`SELECT id FROM ${TABLES[kind]} WHERE id = ?`).get(id) ?? null, null,
        'cleanup must see the committed deletion');
      deletions.push([docType, id]);
      if (deletesRemainingToFail-- > 0) throw new Error('temporary vector service failure');
      docs.delete(`${docType}:${id}`);
      return 1;
    },
  } as unknown as ChromaSyncLike;
  const apply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: chroma });
  const rowId = (kind: IndexedKind, originId = '800') => (store.db.query(
    `SELECT id FROM ${TABLES[kind]} WHERE origin_device_id = 'remote-device' AND origin_local_id = ?`,
  ).get(originId) as { id: number }).id;
  return { store, docs, deletions, apply, rowId, writing: () => writing };
}

describe('remote tombstones remove indexed fragments after commit', () => {
  for (const kind of ['observation', 'summary', 'prompt'] as const) {
    it(`cleans ${kind} fragments using the replica row id and matching document type`, async () => {
      const f = fixture();
      try {
        f.apply.applyOps([op(1, kind)]);
        const localId = f.rowId(kind);
        assert.notEqual(localId, 800, 'origin ids belong to another database');
        await setImmediate();
        assert.equal(f.docs.size, 1);
        const result = f.apply.applyOps([op(2, kind, '800', true)]);
        assert.equal(result.cursor, '2');
        await setImmediate();
        assert.deepEqual(f.deletions, [[DOC_TYPES[kind], localId]]);
        assert.equal(f.docs.size, 0);
        // The head ledger makes redelivery inert, including vector cleanup.
        f.apply.applyOps([{ ...op(3, kind, '800', true) }]);
        await setImmediate();
        assert.equal(f.deletions.length, 1);
      } finally { f.store.close(); }
    });
  }

  it('waits for an older pending write so it cannot recreate the deleted fragments', async () => {
    let release!: () => void;
    const waitForWrite = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ waitForWrite });
    try {
      f.apply.applyOps([op(1, 'observation')]);
      await setImmediate();
      assert.equal(f.writing(), true);
      f.apply.applyOps([op(2, 'observation', '800', true)]);
      await setImmediate();
      assert.equal(f.deletions.length, 0, 'the same-row write still owns its turn');
      release();
      await setImmediate();
      assert.equal(f.deletions.length, 1);
      assert.equal(f.docs.size, 0);
    } finally { release(); await setImmediate(); f.store.close(); }
  });

  it('does not clean vectors for a transaction that rolls back', async () => {
    const f = fixture();
    try {
      f.apply.applyOps([op(1, 'observation')]);
      await setImmediate();
      assert.throws(() => f.apply.applyOps([
        op(2, 'observation', '800', true), op(4, 'observation', '801'),
      ], { requireContiguous: true }), /sequence gap/);
      await setImmediate();
      assert.equal(f.apply.getCursor(), '1');
      assert.equal(f.docs.size, 1);
      assert.equal(f.deletions.length, 0);
      assert.ok(f.rowId('observation'));
    } finally { f.store.close(); }
  });

  it('keeps durable sync advancing and later cleanup running after a vector error', async () => {
    const f = fixture({ failDelete: 1 });
    try {
      f.apply.applyOps([op(1, 'observation'), op(2, 'summary')]);
      await setImmediate();
      const result = f.apply.applyOps([op(3, 'observation', '800', true), op(4, 'summary', '800', true)]);
      assert.equal(result.cursor, '4');
      await setImmediate();
      assert.equal(f.deletions.length, 2);
      assert.equal(f.docs.size, 1, 'one failed best-effort cleanup must not block the next row');
      assert.equal([...f.docs][0].startsWith('observation:'), true);
    } finally { f.store.close(); }
  });
});
