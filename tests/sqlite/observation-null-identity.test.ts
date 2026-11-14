import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { saveMemory } from '../../src/services/memory/save-memory.js';
import { computeObservationContentHash, computeObservationDetailsHash } from '../../src/services/sqlite/observations/store.js';
import { MemoryIngestRoutes } from '../../src/services/worker/http/routes/MemoryIngestRoutes.js';
import type { MemoryIngestDeps } from '../../src/services/memory/ingest.js';

const oldHash = (session: string, title: string, narrative: string | null) => createHash('sha256')
  .update([session, title, narrative ?? ''].join('\0')).digest('hex').slice(0, 16);

describe('null characters in observation identity', () => {
  it('distinguishes field boundaries while preserving ordinary hashes', () => {
    expect(computeObservationContentHash('memory', 'prefix\0suffix', 'body'))
      .not.toBe(computeObservationContentHash('memory', 'prefix', 'suffix\0body'));
    expect(computeObservationContentHash('memory\0prefix', 'suffix', 'body'))
      .not.toBe(computeObservationContentHash('memory', 'prefix\0suffix', 'body'));
    expect(computeObservationContentHash('memory', 'title', 'body')).toBe(oldHash('memory', 'title', 'body'));
  });

  for (const enabled of ['false', 'true']) {
    it(`stores distinct explicit notes and returns their own replay receipts (dedup ${enabled})`, () => {
      const before = process.env.CLAUDE_MEM_DEDUP_ENABLED;
      process.env.CLAUDE_MEM_DEDUP_ENABLED = enabled;
      const store = new SessionStore(':memory:');
      const manager = { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
      try {
        const left = { title: 'prefix\0suffix', text: 'body' };
        const right = { title: 'prefix', text: 'suffix\0body' };
        const first = saveMemory(manager as any, 'notes', left);
        const second = saveMemory(manager as any, 'notes', right);
        expect(second.id).not.toBe(first.id);
        expect(saveMemory(manager as any, 'notes', left).id).toBe(first.id);
        expect(saveMemory(manager as any, 'notes', right).id).toBe(second.id);
        expect(store.db.query('SELECT id,title,narrative FROM observations ORDER BY id').all()).toEqual([
          { id: first.id, title: left.title, narrative: left.text },
          { id: second.id, title: right.title, narrative: right.text },
        ]);
      } finally {
        store.close();
        if (before === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
        else process.env.CLAUDE_MEM_DEDUP_ENABLED = before;
      }
    });
  }

  it('does not mistake a different legacy null-containing note for an exact replay', () => {
    const store = new SessionStore(':memory:');
    const manager = { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    try {
      const first = saveMemory(manager as any, 'notes', { title: 'prefix\0suffix', text: 'body' });
      const row = store.db.query('SELECT memory_session_id FROM observations WHERE id=?').get(first.id) as { memory_session_id: string };
      const legacy = oldHash(row.memory_session_id, 'prefix\0suffix', 'body');
      store.db.query('UPDATE observations SET content_hash=? WHERE id=?').run(legacy, first.id);
      const second = saveMemory(manager as any, 'notes', { title: 'prefix', text: 'suffix\0body' });
      expect(second.id).not.toBe(first.id);
      expect(saveMemory(manager as any, 'notes', { title: 'prefix\0suffix', text: 'body' }).id).toBe(first.id);
      expect(store.getObservationById(second.id)?.narrative).toBe('suffix\0body');
      expect(store.db.query('SELECT content_hash FROM observations WHERE id=?').get(first.id)).toEqual({ content_hash: legacy });
    } finally { store.close(); }
  });

  it('keeps ingest replay receipts compatible without matching another legacy tuple', async () => {
    const store = new SessionStore(':memory:');
    const manager = { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    const route = new MemoryIngestRoutes(manager as any);
    // Exercise the actual ingest dependency, including its pre-store replay lookup.
    const deps = (route as unknown as { buildDeps(): MemoryIngestDeps }).buildDeps();
    const input = { project: 'notes', type: 'discovery', title: 'prefix\0suffix', narrative: 'body',
      subtitle: 'Imported memory (topic)', concepts: ['memory-import'], metadata: {}, createdAtEpoch: Date.now(), sourceFile: 'fixture.md' };
    try {
      const first = await deps.storeMemoryObservation(input);
      const session = store.getOrCreateManualSession('notes');
      store.db.query('UPDATE observations SET content_hash=? WHERE id=?').run(oldHash(session, input.title, input.narrative), first.id);
      expect(await deps.storeMemoryObservation(input)).toEqual({ id: first.id, deduped: true });
      const changed = { ...input, title: 'prefix', narrative: 'suffix\0body' };
      const second = await deps.storeMemoryObservation(changed);
      expect(second.id).not.toBe(first.id);
      expect(second.deduped).toBe(false);
      expect(await deps.storeMemoryObservation(changed)).toEqual({ id: second.id, deduped: true });
      expect(store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 2 });
    } finally { store.close(); }
  });

  it('retains old row hashes and structured-variant receipts, even after the old base row is deleted', () => {
    const store = new SessionStore(':memory:');
    const session = store.createSDKSession('null-compatibility', 'notes', 'synthetic');
    store.updateMemorySessionId(session, 'memory');
    const observation = { type: 'discovery', title: 'prefix\0suffix', narrative: 'body', subtitle: null,
      facts: ['first'], concepts: [], files_read: [], files_modified: [] };
    const changed = { ...observation, facts: ['second'] };
    const options = { skipTitleDedup: true };
    try {
      const first = store.storeObservation('memory', 'notes', observation, 0, 0, undefined, undefined, options);
      const legacy = oldHash('memory', observation.title, observation.narrative);
      store.db.query('UPDATE observations SET content_hash=? WHERE id=?').run(legacy, first.id);
      expect(store.storeObservation('memory', 'notes', observation, 0, 0, undefined, undefined, options).id).toBe(first.id);
      const second = store.storeObservation('memory', 'notes', changed, 0, 0, undefined, undefined, options);
      expect(second.id).not.toBe(first.id);
      expect(store.db.query('SELECT content_hash FROM observations WHERE id=?').get(first.id)).toEqual({ content_hash: legacy });
      // Recreate a pre-fix structured variant, then remove its base row.
      store.db.query('UPDATE observations SET content_hash=? WHERE id=?').run(computeObservationDetailsHash(legacy, changed), second.id);
      store.db.query('DELETE FROM observations WHERE id=?').run(first.id);
      expect(store.storeObservation('memory', 'notes', changed, 0, 0, undefined, undefined, options).id).toBe(second.id);
      expect(store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
    } finally { store.close(); }
  });
});
