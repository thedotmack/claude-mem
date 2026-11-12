import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { saveMemory } from '../../src/services/memory/save-memory.js';

function session(store: SessionStore, id = 1, project = 'Project', platform = 'claude') {
  store.db.query(`INSERT INTO sdk_sessions
    (id, content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch)
    VALUES (?, ?, ?, ?, ?, '2026-11-11T00:00:00Z', 1794355200000)`)
    .run(id, `content-${id}`, `memory-${id}`, project, platform);
}

function observation(store: SessionStore, id: number, metadata: string | null, sessionId = 1, project = 'Project') {
  store.db.query(`INSERT INTO observations
    (id, memory_session_id, project, type, title, metadata, created_at, created_at_epoch)
    VALUES (?, ?, ?, 'discovery', ?, ?, '2026-11-11T00:00:00Z', 1794355200000)`)
    .run(id, `memory-${sessionId}`, project, `Memory ${id}`, metadata);
}

function replay(store: SessionStore, fingerprint: string, project = 'Project', platformSource?: string) {
  const manager = {
    getConnection: () => store.db,
    getSessionStore: () => { throw new Error('An exact replay must not write a new memory'); },
  };
  return saveMemory(manager as any, project, {
    text: 'Replayed source text', metadata: { sourceFingerprint: fingerprint, platformSource },
  });
}

function expected(id: number, project = 'Project') {
  return { success: true, id, title: `Memory ${id}`, project, duplicate: true,
    message: `Memory already saved as observation #${id}` };
}

describe('native memory replay lookup', () => {
  it('retains the latest match within the exact project and normalized platform', () => {
    const store = new SessionStore(':memory:');
    try {
      session(store); session(store, 2, 'Project', 'codex');
      session(store, 3, 'Other'); session(store, 4, 'project'); session(store, 5, 'Project', '');
      for (const [id, sessionId, project] of [[10, 1, 'Project'], [20, 2, 'Project'],
        [30, 3, 'Other'], [40, 4, 'project'], [50, 5, 'Project']] as const) {
        observation(store, id, '{"sourceFingerprint":"shared"}', sessionId, project);
      }
      expect(replay(store, 'shared')).toEqual(expected(50));
      expect(replay(store, 'shared', 'Project', ' Codex ')).toEqual(expected(20));
      expect(replay(store, 'shared', 'Other')).toEqual(expected(30, 'Other'));
      expect(replay(store, 'shared', 'project')).toEqual(expected(40, 'project'));
      expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 5 });
    } finally { store.close(); }
  });

  it('preserves guarded JSON comparison semantics for malformed, missing and non-string fields', () => {
    const store = new SessionStore(':memory:');
    try {
      session(store);
      observation(store, 10, '{"sourceFingerprint":"13"}');
      observation(store, 20, '{"sourceFingerprint":13}');
      observation(store, 30, '{"sourceFingerprint":["note"]}');
      observation(store, 40, '{"sourceFingerprint":null}');
      observation(store, 50, '{"unrelated":"13"}');
      observation(store, 60, '{broken');
      observation(store, 70, null);
      expect(replay(store, '13')).toEqual(expected(10));
      // SQLite's existing json_extract comparison also accepts serialized arrays.
      expect(replay(store, '["note"]')).toEqual(expected(30));
      expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 7 });
    } finally { store.close(); }
  });

  it('tracks metadata updates and deletion without returning stale fingerprint entries', () => {
    const store = new SessionStore(':memory:');
    try {
      session(store);
      observation(store, 1, '{"sourceFingerprint":"alpha"}');
      observation(store, 2, '{"sourceFingerprint":"beta"}');
      observation(store, 3, '{"sourceFingerprint":"alpha"}');
      expect(replay(store, 'alpha')).toEqual(expected(3));
      store.db.query('UPDATE observations SET metadata = ? WHERE id = 3').run('{"sourceFingerprint":"beta"}');
      expect(replay(store, 'alpha')).toEqual(expected(1));
      expect(replay(store, 'beta')).toEqual(expected(3));
      store.db.query('UPDATE observations SET metadata = ? WHERE id = 3').run('{broken');
      expect(replay(store, 'beta')).toEqual(expected(2));
      store.db.query('DELETE FROM observations WHERE id = 2').run();
      observation(store, 4, '{"sourceFingerprint":"beta"}');
      expect(replay(store, 'beta')).toEqual(expected(4));
    } finally { store.close(); }
  });

  it('reopens an existing database containing malformed metadata without changing replay results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memory-replay-index-'));
    const path = join(directory, 'memory.db');
    let store: SessionStore | undefined;
    try {
      store = new SessionStore(path);
      store.db.run('DROP INDEX IF EXISTS idx_observations_source_fingerprint');
      session(store);
      observation(store, 1, '{"sourceFingerprint":"existing"}');
      observation(store, 2, '{broken');
      const before = store.db.query('SELECT id, project, title, metadata FROM observations ORDER BY id').all();
      store.close(); store = undefined;
      store = new SessionStore(path);
      expect(replay(store, 'existing')).toEqual(expected(1));
      expect(store.db.query('SELECT id, project, title, metadata FROM observations ORDER BY id').all()).toEqual(before);
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('seeks by project and fingerprint in the actual saveMemory query', () => {
    const store = new SessionStore(':memory:');
    try {
      session(store);
      observation(store, 1, '{"sourceFingerprint":"needle"}');
      for (let id = 2; id <= 301; id++) observation(store, id, id % 2 ? null : '{"unrelated":"history"}');
      const query = store.db.query.bind(store.db);
      let replaySql = '';
      const spy = spyOn(store.db, 'query').mockImplementation((sql: string) => {
        if (sql.includes('sourceFingerprint')) replaySql = sql;
        return query(sql);
      });
      try { expect(replay(store, 'needle')).toEqual(expected(1)); }
      finally { spy.mockRestore(); }
      expect(replaySql).toContain('SELECT o.id, o.title');
      const plan = (store.db.query(`EXPLAIN QUERY PLAN ${replaySql}`).all('Project', 'claude', 'needle') as
        Array<{ detail: string }>).map(row => row.detail).join('\n');
      expect(plan).toContain('idx_observations_source_fingerprint');
      expect(plan).toContain('project=? AND <expr>=?');
    } finally { store.close(); }
  });
});
