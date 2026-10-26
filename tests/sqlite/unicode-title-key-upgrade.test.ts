import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { computeTitleNormKey } from '../../src/services/sqlite/dedup-store.js';

const observation = (title: string) => ({ type: 'discovery', title, subtitle: null, narrative: title,
  facts: [], concepts: [], files_read: [], files_modified: [] });
function legacyKey(title: string, platform = 'claude', agent = 'main') {
  const normalized = title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`project\x00${platform}\x00${agent}\x00${normalized}`).digest('hex').slice(0, 32);
}

it('rebuilds old Unicode keys before storage can merge a distinct incoming title', () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-unicode-upgrade-'));
  const saved = process.env.CLAUDE_MEM_DEDUP_ENABLED;
  let store: SessionStore | undefined;
  try {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'false';
    const path = join(root, 'memory.db');
    store = new SessionStore(path);
    const sid = store.createSDKSession('original', 'project', 'prompt');
    store.updateMemorySessionId(sid, 'old');
    const hindi = store.storeObservation('old', 'project', observation('कि'), 1).id;
    const accent = store.storeObservation('old', 'project', observation('Cafe\u0301 fix'), 1).id;
    for (const [id, title] of [[hindi, 'कि'], [accent, 'Cafe\u0301 fix']] as const) {
      store.db.run('UPDATE observations SET title_norm_key = ? WHERE id = ?', [legacyKey(title), id]);
    }
    store.db.run('DELETE FROM schema_versions WHERE version = 65');
    store.close();
    store = new SessionStore(path);
    expect(store.db.query('SELECT title_norm_key FROM observations WHERE id = ?').get(hindi)).toEqual({ title_norm_key: computeTitleNormKey('project', 'claude', 'कि') });
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    for (const mem of ['new', 'accent']) {
      const id = store.createSDKSession(mem, 'project', 'prompt'); store.updateMemorySessionId(id, mem);
    }
    const distinct = store.storeObservation('new', 'project', observation('क'), 1);
    expect(distinct.id).not.toBe(hindi);
    expect(distinct.mergedIntoExisting).toBe(false);
    expect(store.db.query('SELECT occurrence_count FROM observations WHERE id = ?').get(hindi)).toEqual({ occurrence_count: 1 });
    expect(store.storeObservation('accent', 'project', observation('Café fix'), 1).id).toBe(accent);
    const before = store.db.query('SELECT id, title_norm_key, occurrence_count FROM observations ORDER BY id').all();
    store.close(); store = new SessionStore(path);
    expect(store.db.query('SELECT id, title_norm_key, occurrence_count FROM observations ORDER BY id').all()).toEqual(before);
  } finally {
    store?.close(); rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED; else process.env.CLAUDE_MEM_DEDUP_ENABLED = saved;
  }
});

it('rolls back every key and the migration marker if a key update fails', () => {
  const store = new SessionStore(':memory:');
  try {
    const sid = store.createSDKSession('atomic', 'project', 'prompt'); store.updateMemorySessionId(sid, 'atomic');
    const first = store.storeObservation('atomic', 'project', observation('कि'), 1).id;
    const second = store.storeObservation('atomic', 'project', observation('कि second'), 1).id;
    store.db.run("UPDATE observations SET title_norm_key = 'old'");
    store.db.run('DELETE FROM schema_versions WHERE version = 65');
    store.db.run(`CREATE TRIGGER fail_key_update BEFORE UPDATE OF title_norm_key ON observations WHEN old.id = ${second} BEGIN SELECT RAISE(ABORT, 'fixture key failure'); END`);
    expect(() => new SessionStore(store.db)).toThrow('fixture key failure');
    expect(store.db.query('SELECT title_norm_key FROM observations WHERE id = ?').get(first)).toEqual({ title_norm_key: 'old' });
    expect(store.db.query('SELECT version FROM schema_versions WHERE version = 65').get()).toBeNull();
    store.db.run('DROP TRIGGER fail_key_update');
    new SessionStore(store.db);
    expect(store.db.query('SELECT title_norm_key FROM observations WHERE id = ?').get(first)).toEqual({ title_norm_key: computeTitleNormKey('project', 'claude', 'कि') });
  } finally { store.close(); }
});

it('preserves platform and subagent scopes while refreshing keys', () => {
  const store = new SessionStore(':memory:');
  try {
    const keys: Array<{ id: number; platform: string; subagent: boolean }> = [];
    for (const [memory, platform, subagent] of [['main', 'claude', false], ['codex', 'codex', false], ['sub', 'claude', true]] as const) {
      const sid = store.createSDKSession(memory, 'project', 'prompt', undefined, platform);
      store.updateMemorySessionId(sid, memory);
      const id = store.storeObservation(memory, 'project', { ...observation('कि'),
        ...(subagent ? { agent_id: 'agent-1', agent_type: 'Explore' } : {}) }, 1).id;
      store.db.run('UPDATE observations SET title_norm_key = ? WHERE id = ?', [legacyKey('कि', platform, subagent ? 'subagent' : 'main'), id]);
      keys.push({ id, platform, subagent });
    }
    store.db.run('DELETE FROM schema_versions WHERE version = 65');
    new SessionStore(store.db);
    for (const row of keys) {
      expect(store.db.query('SELECT title_norm_key FROM observations WHERE id = ?').get(row.id))
        .toEqual({ title_norm_key: computeTitleNormKey('project', row.platform, 'कि', row.subagent) });
    }
    expect(new Set(keys.map(row => computeTitleNormKey('project', row.platform, 'कि', row.subagent))).size).toBe(3);
  } finally { store.close(); }
});
