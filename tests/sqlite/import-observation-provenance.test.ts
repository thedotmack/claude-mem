import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { saveMemory } from '../../src/services/memory/save-memory.js';

function session(store: SessionStore): void {
  store.ensureMemorySessionIdRegistered(store.createSDKSession('host', 'app', 'prompt'), 'memory');
}

function exportedObservation(store: SessionStore): any {
  session(store);
  const result = store.storeObservation('memory', 'app', {
    type: 'discovery', title: 'Saved working note', subtitle: null,
    narrative: 'Keep this decision', facts: [], concepts: ['how-it-works'],
    files_read: ['src/main.ts'], files_modified: [],
    metadata: JSON.stringify({ source: 'memory-file', sourceFingerprint: 'note-revision', sourcePath: '/notes/decision.md' }),
  }, 1, 0, 1_700_000_000_000);
  store.db.prepare(`UPDATE observations SET generated_by_model = ?, occurrence_count = ?,
    reinforcement_dates = ?, last_reinforced = ?, origin_device_id = ?, origin_local_id = ?, synced_at = ?
    WHERE id = ?`).run('recorded-observer', 4, '["2023-11-14","2026-11-01"]', '2026-11-01', 'source-device', '99', 123, result.id);
  return store.getObservationsByIds([result.id])[0];
}

describe('imported observation provenance and reinforcement', () => {
  it('round-trips recorded metadata without copying device-local sync identity', () => {
    const source = new SessionStore(':memory:');
    const target = new SessionStore(':memory:');
    try {
      const exported = exportedObservation(source);
      session(target);
      const imported = target.importObservation(exported);
      const restored = target.getObservationsByIds([imported.id])[0] as any;
      for (const field of ['metadata', 'generated_by_model', 'occurrence_count', 'reinforcement_dates', 'last_reinforced']) {
        expect(restored[field]).toEqual(exported[field]);
      }
      expect(restored.origin_device_id).toBeNull();
      expect(restored.origin_local_id).toBeNull();
      expect(restored.synced_at).toBeNull();
      expect(target.importObservation(exported)).toEqual({ imported: false, id: imported.id });
    } finally { source.close(); target.close(); }
  });

  it('recognizes a restored file-memory fingerprint on the next bridge scan', () => {
    const source = new SessionStore(':memory:');
    const target = new SessionStore(':memory:');
    try {
      const exported = exportedObservation(source);
      session(target);
      const imported = target.importObservation(exported);
      const result = saveMemory({
        getConnection: () => target.db,
        getSessionStore: () => target,
        getCloudSync: () => null,
        getChromaSync: () => null,
      } as any, 'app', { text: exported.narrative, project: 'app', metadata: JSON.parse(exported.metadata) });
      expect(result.id).toBe(imported.id);
      expect(target.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
    } finally { source.close(); target.close(); }
  });

  it('keeps legacy exports valid and does not rewrite a newer local history on replay', () => {
    const source = new SessionStore(':memory:');
    const target = new SessionStore(':memory:');
    try {
      const exported = exportedObservation(source);
      for (const field of ['metadata', 'generated_by_model', 'occurrence_count', 'reinforcement_dates', 'last_reinforced']) delete exported[field];
      session(target);
      const imported = target.importObservation(exported);
      const restored = target.getObservationsByIds([imported.id])[0] as any;
      expect(restored.metadata).toBeNull();
      expect(restored.generated_by_model).toBeNull();
      expect(restored.occurrence_count).toBe(1);
      expect(restored.reinforcement_dates).toBeNull();
      target.db.prepare('UPDATE observations SET occurrence_count = 9 WHERE id = ?').run(imported.id);
      expect(target.importObservation({ ...exported, occurrence_count: 2 }).imported).toBe(false);
      expect((target.getObservationsByIds([imported.id])[0] as any).occurrence_count).toBe(9);
    } finally { source.close(); target.close(); }
  });

  it('rejects unbindable optional metadata before writing any row', () => {
    const source = new SessionStore(':memory:');
    const target = new SessionStore(':memory:');
    try {
      const exported = exportedObservation(source);
      session(target);
      for (const invalid of [{ metadata: {} }, { generated_by_model: [] }, { occurrence_count: -1 }, { reinforcement_dates: {} }, { last_reinforced: false }]) {
        expect(() => target.importObservation({ ...exported, ...invalid })).toThrow();
      }
      expect(target.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
    } finally { source.close(); target.close(); }
  });
});
