import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply, type ChromaSyncLike, type SyncOp } from '../../../src/services/sync/SyncApply.js';

type Kind = 'observation' | 'summary';
const TABLES = { observation: 'observations', summary: 'session_summaries' };
const NOW = 1_750_000_000_000;

function rowOp(seq: number, kind: Kind, rev = 1): SyncOp {
  const common = { memory_session_id: 'remote-memory', project: 'checkout', created_at_epoch: NOW, prompt_number: 1 };
  const body = kind === 'observation' ? { ...common, type: 'discovery', title: 'Useful memory', narrative: 'Stored detail' }
    : { ...common, request: 'Build', completed: 'Done' };
  return {
    seq: String(seq), kind, origin_device: 'remote-device', origin_id: '800', rev: String(rev),
    body: JSON.stringify(body), server_ts: NOW,
  };
}

function remap(seq: number, fields: Record<string, string>, options: { rev?: number; where?: Record<string, unknown> } = {}): SyncOp {
  return {
    seq: String(seq), kind: 'mutation', origin_device: 'remote-device', origin_id: `remap-${seq}`,
    rev: String(options.rev ?? 2), server_ts: NOW,
    body: JSON.stringify({ op: 'remap_project', where: options.where ?? { project: 'checkout' }, fields }),
  };
}

function fixture(options: { waitForFirstWrite?: Promise<void>; failWrite?: number } = {}) {
  const store = new SessionStore(':memory:');
  const docs = new Map<string, { project: string; merged: string | null }>();
  const calls: string[] = [];
  let failuresRemaining = options.failWrite ?? 0;
  const write = async (kind: Kind, args: Parameters<ChromaSyncLike['syncSummary']>) => {
    assert.equal(store.db.inTransaction, false, 'vector work must begin after commit');
    const [id, , project, content] = args;
    const current = args[8]?.();
    if (!current) return;
    assert.equal(current.row.project, project, 'queued body starts with the updated row');
    assert.equal(current.row.merged_into_project ?? null, content.merged_into_project ?? null);
    const snapshot = { project: current.row.project, merged: current.row.merged_into_project ?? null };
    calls.push(`${kind}:${id}`);
    if (calls.length === 1) await options.waitForFirstWrite;
    if (failuresRemaining-- > 0) throw new Error('temporary vector failure');
    docs.set(`${kind}:${id}`, snapshot);
  };
  const chroma = {
    syncObservation: (...args: Parameters<ChromaSyncLike['syncObservation']>) => write('observation', args as unknown as Parameters<ChromaSyncLike['syncSummary']>),
    syncSummary: (...args: Parameters<ChromaSyncLike['syncSummary']>) => write('summary', args),
    syncUserPrompt: async () => {},
  } satisfies ChromaSyncLike;
  const apply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: chroma });
  const key = (kind: Kind) => `${kind}:${(store.db.query(
    `SELECT id FROM ${TABLES[kind]} WHERE origin_device_id = 'remote-device' AND origin_local_id = '800'`,
  ).get() as { id: number }).id}`;
  return { store, apply, docs, calls, key };
}

describe('remote project remaps refresh vector metadata after commit', () => {
  for (const kind of ['observation', 'summary'] as const) {
    it(`refreshes an already indexed ${kind} even when the same-revision row is skipped`, async () => {
      const f = fixture();
      try {
        f.apply.applyOps([rowOp(1, kind)]);
        await setImmediate();
        assert.deepEqual(f.docs.get(f.key(kind)), { project: 'checkout', merged: null });
        f.apply.applyOps([remap(2, { merged_into_project: 'parent' })]);
        const result = f.apply.applyOps([rowOp(3, kind, 2)]);
        assert.equal(result.skippedStale, 1, 'the row echo cannot repair the vector metadata');
        await setImmediate();
        assert.deepEqual(f.docs.get(f.key(kind)), { project: 'checkout', merged: 'parent' });
        assert.equal(f.calls.length, 2);
      } finally { f.store.close(); }
    });
  }

  it('moves both memory kinds and their session to the new project', async () => {
    const f = fixture();
    try {
      f.apply.applyOps([rowOp(1, 'observation'), rowOp(2, 'summary')]);
      await setImmediate();
      f.apply.applyOps([remap(3, { project: 'new-project' }, { where: { memory_session_id: 'remote-memory' } })]);
      await setImmediate();
      for (const kind of ['observation', 'summary'] as const) {
        assert.deepEqual(f.docs.get(f.key(kind)), { project: 'new-project', merged: null });
      }
      assert.equal((f.store.db.query('SELECT project FROM sdk_sessions').get() as { project: string }).project, 'new-project');
    } finally { f.store.close(); }
  });

  it('does not forward stale, nonmatching or rolled-back remaps', async () => {
    const f = fixture();
    try {
      f.apply.applyOps([rowOp(1, 'observation', 3)]);
      await setImmediate();
      f.apply.applyOps([
        remap(2, { merged_into_project: 'parent' }),
        remap(3, { merged_into_project: 'parent' }, { rev: 4, where: { project: 'elsewhere' } }),
      ]);
      assert.throws(() => f.apply.applyOps([
        remap(4, { merged_into_project: 'parent' }, { rev: 4 }), rowOp(6, 'summary'),
      ], { requireContiguous: true }), /sequence gap/);
      await setImmediate();
      assert.equal(f.calls.length, 1);
      assert.equal(f.apply.getCursor(), '3');
      assert.deepEqual(f.docs.get(f.key('observation')), { project: 'checkout', merged: null });
    } finally { f.store.close(); }
  });

  it('refreshes behind an older in-flight write so it cannot restore the old project', async () => {
    let release!: () => void;
    const waitForFirstWrite = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ waitForFirstWrite });
    try {
      f.apply.applyOps([rowOp(1, 'observation')]);
      await setImmediate();
      f.apply.applyOps([remap(2, { project: 'new-project' })]);
      await setImmediate();
      assert.equal(f.calls.length, 1, 'the older write still owns the row');
      release();
      await setImmediate();
      assert.equal(f.calls.length, 2);
      assert.deepEqual(f.docs.get(f.key('observation')), { project: 'new-project', merged: null });
    } finally { release(); await setImmediate(); f.store.close(); }
  });

  it('keeps the committed remap and advances later work after a vector failure', async () => {
    const f = fixture({ failWrite: 1 });
    try {
      f.apply.applyOps([rowOp(1, 'observation')]);
      await setImmediate();
      f.apply.applyOps([remap(2, { merged_into_project: 'parent' })]);
      await setImmediate();
      assert.equal(f.apply.getCursor(), '2');
      assert.deepEqual(f.docs.get(f.key('observation')), { project: 'checkout', merged: 'parent' });
    } finally { f.store.close(); }
  });
});
