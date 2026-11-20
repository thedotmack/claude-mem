import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryFileWatcher } from '../../src/services/memory/file-watcher.js';
import { saveMemory } from '../../src/services/memory/save-memory.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';

function manager(store: SessionStore) {
  return { getConnection: () => store.db, getSessionStore: () => store,
    getCloudSync: () => null, getChromaSync: () => null } as any;
}

it('scopes exact file replay to the normalized source that owns the note', () => {
  const store = new SessionStore(':memory:');
  try {
    const search = new SessionSearch(store.db);
    const save = (platformSource?: string) => saveMemory(manager(store), 'project', {
      text: 'sourceproof deployment preference', title: 'Deployment',
      metadata: { sourceFingerprint: 'same-file-snapshot', ...(platformSource ? { platformSource } : {}) },
    });
    const claude = save();
    const codex = save(' Codex ');
    expect(codex.id).not.toBe(claude.id);
    expect(save('codex').id).toBe(codex.id);
    expect(save('claude').id).toBe(claude.id);
    expect(store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 2 });
    for (const [platformSource, id] of [['claude', claude.id], ['codex', codex.id]] as const) {
      expect(search.searchObservations('sourceproof', { project: 'project', platformSource }).map(row => row.id)).toEqual([id]);
    }
  } finally { store.close(); }
});

it('keeps concurrent watch-root source scopes independent and deduplicates their restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-platform-'));
  const store = new SessionStore(':memory:');
  try {
    writeFileSync(join(directory, 'note.md'), 'shared source file');
    const roots = ['codex', 'cursor'].map(platformSource => ({ path: directory, project: 'project', platformSource }));
    const scan = () => {
      const watcher = new MemoryFileWatcher(roots, input => saveMemory(manager(store), 'project', input), 10);
      watcher.scan(0); watcher.scan(11); watcher.stop();
    };
    scan();
    const rows = () => store.db.query(`SELECT o.id, s.platform_source FROM observations o
      JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id ORDER BY o.id`).all();
    const first = rows();
    expect(first).toEqual([{ id: 1, platform_source: 'codex' }, { id: 2, platform_source: 'cursor' }]);
    scan();
    expect(rows()).toEqual(first);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
