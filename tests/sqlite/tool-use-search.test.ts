import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { configureToolUseIndex, configureToolUseIndexAsync, searchToolUses, toolUseIndexStatus } from '../../src/services/sqlite/tool-use-search.js';
import { MAX_TOOL_PAYLOAD_BYTES, purgeLinkedToolUses } from '../../src/services/sqlite/tool-uses.js';

const stores: SessionStore[] = [];
const directories: string[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture(file = ':memory:') {
  const store = new SessionStore(file); stores.push(store);
  const write = (id: string, response: string | null = 'DB_CONN_1042 pool size 30', extra: Record<string, unknown> = {}) => store.upsertToolUse({
    toolUseId: id, contentSessionId: 'session', toolName: 'Bash', project: 'shop-api',
    toolInput: 'npm run diagnose-db', toolResponse: response, createdAtEpoch: 1_700_000_000_000, ...extra,
  });
  return { store, db: store.db, write, enable: () => configureToolUseIndex(store.db, true),
    find: (q = 'DB_CONN_1042', options = {}) => searchToolUses(store.db, q, options) };
}

describe('optional raw-tool content index (#4060)', () => {
  it('is absent by default and backfills historical bodies only on explicit initialization', () => {
    const h = fixture(); const id = h.write('old');
    new SessionSearch(h.db);
    expect(h.find().deep.status).toBe('disabled');
    new SessionSearch(h.db, { toolUseIndexEnabled: true });
    expect(h.find().toolUses.map(r => r.id)).toEqual([id!]);
    expect(h.find().toolUses[0]).not.toHaveProperty('tool_response');
    expect(h.find().toolUses[0].snippet).toContain('DB_CONN_1042');
  });

  it('indexes inserts and replayed responses but does not rewrite identical bodies or metadata', () => {
    const h = fixture(); h.enable(); const id = h.write('replayed', null);
    expect(h.find().toolUses).toEqual([]);
    h.write('replayed');
    expect(h.find().toolUses.map(r => r.id)).toEqual([id!]);
    const changes = () => (h.db.query('SELECT total_changes() AS n').get() as {n: number}).n;
    const before = changes(); h.write('replayed');
    expect(changes() - before).toBe(1); // only the base row, no shadow-table writes
    const metadata = changes(); h.db.run('UPDATE tool_uses SET observation_id = 999, project = ? WHERE id = ?', ['renamed', id!]);
    expect(changes() - metadata).toBe(1);
    expect(h.find('DB_CONN_1042', { project: 'shop-api' }).toolUses).toEqual([]);
    expect(h.find('DB_CONN_1042', { project: 'renamed' }).toolUses).toHaveLength(1);
    h.write('replayed', 'DB_CONN_2000 corrected');
    expect(h.find().toolUses).toEqual([]);
    expect(h.find('DB_CONN_2000').toolUses).toHaveLength(1);
    h.db.run('DELETE FROM tool_uses WHERE id = ?', [id!]);
    expect(h.find('DB_CONN_2000').toolUses).toEqual([]);
  });

  it('repairs missing triggers before serving subsequent updates/deletes', () => {
    const h = fixture(); h.enable(); h.write('old');
    h.db.run('DROP TRIGGER tool_uses_fts_ai'); h.write('missed');
    expect(toolUseIndexStatus(h.db)).toBe('not_ready');
    h.enable(); h.write('missed', 'replacement');
    h.db.run("DELETE FROM tool_uses WHERE tool_use_id = 'old'");
    expect(h.find().toolUses).toEqual([]);
    expect(h.find('replacement').toolUses).toHaveLength(1);
    h.db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('integrity-check', 1)");
  });

  it('resumes a committed cursor while inserts, updates and deletes interleave with building', async () => {
    const h = fixture();
    for (let i = 0; i < 150; i++) h.write('row-' + i);
    const abort = new AbortController();
    const build = configureToolUseIndexAsync(h.db, true, abort.signal);
    expect(toolUseIndexStatus(h.db)).toBe('building');
    expect(h.find().deep.status).toBe('building');
    // Both sides of the committed 64-row cursor, plus a newly ingested row.
    h.write('row-1', 'changed_before_cursor'); h.write('row-140', 'changed_after_cursor');
    h.db.run("DELETE FROM tool_uses WHERE tool_use_id IN ('row-2', 'row-141')");
    h.write('new', 'new_during_build');
    abort.abort(); await build;
    expect(toolUseIndexStatus(h.db)).toBe('building');
    await configureToolUseIndexAsync(h.db, true);
    expect(h.find('changed_before_cursor').toolUses).toHaveLength(1);
    expect(h.find('changed_after_cursor').toolUses).toHaveLength(1);
    expect(h.find('new_during_build').toolUses).toHaveLength(1);
    h.db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('integrity-check', 1)");
  });

  it('refuses to overwrite a newer derived index version', () => {
    const h = fixture(); h.enable();
    h.db.run('UPDATE tool_uses_search_schema SET version = 99');
    expect(() => h.enable()).toThrow('newer version');
    expect(() => configureToolUseIndex(h.db, false)).toThrow('newer version');
    expect(h.db.query('SELECT version FROM tool_uses_search_schema').get()).toEqual({ version: 99 });
  });

  it('is idempotent and disabling removes only the derived index', () => {
    const h = fixture(); const id = h.write('one'); h.enable();
    const before = h.db.query('SELECT total_changes() n').get(); h.enable();
    expect(h.db.query('SELECT total_changes() n').get()).toEqual(before);
    configureToolUseIndex(h.db, false);
    expect(h.find().deep.status).toBe('disabled');
    expect(h.store.getToolUsesByIds([id!])).toHaveLength(1);
    h.write('two'); h.enable(); expect(h.find().toolUses).toHaveLength(2);
  });

  it('rolls back an incomplete setup rather than leaving a partial ready index', () => {
    const h = fixture(); h.write('old');
    h.db.run('CREATE TABLE tool_uses_search_schema(wrong_shape TEXT)');
    expect(() => h.enable()).toThrow();
    expect(h.db.query("SELECT 1 FROM sqlite_master WHERE name='tool_uses_fts'").get()).toBeNull();
    h.db.run('DROP TABLE tool_uses_search_schema'); h.enable();
    expect(h.find().toolUses).toHaveLength(1);
  });

  it('surfaces index failures: a failed trigger does not falsely persist raw data', () => {
    const h = fixture(); h.enable();
    h.db.run('DROP TABLE tool_uses_fts');
    expect(() => h.write('failed')).toThrow();
    expect(h.db.query("SELECT id FROM tool_uses WHERE tool_use_id='failed'").get()).toBeNull();
  });

  it('keeps all project, platform and date filters inside the SQL limit', () => {
    const h = fixture(); h.enable();
    for (let i = 0; i < 12; i++) h.write('other-' + i, undefined, { project: 'other', platformSource: 'codex', createdAtEpoch: 1_700_000_000_001 + i });
    const id = h.write('mine', undefined, { platformSource: 'codex' });
    h.write('wrong-platform');
    const options = { projects: ['SHOP-API'], platformSource: 'codex', limit: 1, dateRange: { end: 1_700_000_000_000 } };
    expect(h.find('DB_CONN_1042', options).toolUses.map(r => r.id)).toEqual([id!]);
    expect(h.find('DB_CONN_1042', options).deep.hasMore).toBe(false);
    expect(h.find().deep.hasMore).toBe(true);
  });

  it('requires every FTS term and treats operators and punctuation as literal input', () => {
    const h = fixture(); h.enable(); h.write('one');
    expect(h.find('DB_CONN_1042 30').toolUses).toHaveLength(1);
    expect(h.find('DB_CONN_1042 missing 30').toolUses).toEqual([]);
    expect(h.find('DB_CONN_104').toolUses).toEqual([]);
    expect(h.find('DB_CONN_1042 OR nonexistent').toolUses).toEqual([]);
    expect(h.find('"DB_CONN_1042"').toolUses).toHaveLength(1);
    expect(h.find('src/missing.ts').toolUses).toEqual([]);
  });

  it('shares CJK and mixed-script AND matching, including escaped LIKE wildcards', () => {
    const h = fixture(); h.enable(); h.write('cjk', '数据库连接池 worker 配置已修复');
    expect(h.find('数据').toolUses).toHaveLength(1);
    expect(h.find('worker 连接池').toolUses).toHaveLength(1);
    expect(h.find('missing 连接池').toolUses).toEqual([]);
    expect(h.find('数据%池').toolUses).toEqual([]);
    expect(h.find('数据_池').toolUses).toEqual([]);
    expect(h.find('连接池', { project: 'other' }).toolUses).toEqual([]);
  });

  it('indexes only stored bytes and bounds snippets even for a single enormous token', () => {
    const h = fixture(); h.enable();
    h.write('large', 'x'.repeat(MAX_TOOL_PAYLOAD_BYTES) + ' lost_after_storage_cap');
    expect(h.find('lost_after_storage_cap').toolUses).toEqual([]);
    expect(h.find('x'.repeat(4097)).deep.status).toBe('not_applicable');
    h.write('long', 'longword'.repeat(400) + ' needle');
    expect(h.find('needle').toolUses[0].snippet.length).toBeLessThanOrEqual(480);
  });

  it('keeps orphan evidence indexed while retention removes only live-linked old rows', () => {
    const h = fixture(); h.enable();
    const session = h.store.createSDKSession('session', 'shop-api', 'prompt');
    h.store.ensureMemorySessionIdRegistered(session, 'memory');
    let observationIndex = 0;
    const observation = () => h.store.storeObservation('memory', 'shop-api', {
      type: 'discovery', title: 'summary-' + observationIndex++, subtitle: null, narrative: '',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1).id;
    const linked = h.write('linked')!, orphan = h.write('orphan')!, unlinked = h.write('unlinked')!;
    const live = observation(), deleted = observation();
    h.db.run('UPDATE tool_uses SET observation_id = ? WHERE id = ?', [live, linked]);
    h.db.run('UPDATE tool_uses SET observation_id = ? WHERE id = ?', [deleted, orphan]);
    h.db.run('DELETE FROM observations WHERE id = ?', [deleted]);
    expect(purgeLinkedToolUses(h.db, 30, 1_800_000_000_000)).toBe(1);
    expect(h.find().toolUses.map(r => r.id).sort()).toEqual([orphan, unlinked].sort());
    h.db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('merge', -16)");
    h.db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('integrity-check', 1)");
    h.db.run('UPDATE tool_uses SET observation_id = ? WHERE id = ?', [live, unlinked]);
    h.db.run('DROP TABLE tool_uses_fts');
    expect(purgeLinkedToolUses(h.db, 30, 1_800_000_000_000)).toBe(0);
    expect(h.store.getToolUsesByIds([unlinked])).toHaveLength(1); // failed delete rolls back
  });

  it.skipIf(process.platform === 'win32')('resumes after process death and rolls back an interrupted indexed mutation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'raw-search-crash-')); directories.push(dir);
    const file = path.join(dir, 'source.db');
    const h = fixture(file);
    for (let i = 0; i < 150; i++) h.write('row-' + i);
    const child = Bun.spawnSync([process.execPath, '-e', `
      import { Database } from 'bun:sqlite';
      import { configureToolUseIndexAsync } from './src/services/sqlite/tool-use-search.ts';
      const db = new Database(${JSON.stringify(file)});
      void configureToolUseIndexAsync(db, true); // commits first batch before yielding
      db.transaction(() => {
        db.run("UPDATE tool_uses SET tool_response = 'uncommitted mutation' WHERE id = 1");
        process.kill(process.pid, 'SIGKILL');
      })();
    `], { cwd: path.join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
    expect(child.signalCode).toBe('SIGKILL');
    expect(h.db.query('SELECT state, cursor FROM tool_uses_search_schema').get()).toEqual({state:'building',cursor:64});
    expect(h.find().deep.status).toBe('building');
    h.enable();
    expect(h.find('uncommitted').toolUses).toEqual([]);
    expect(h.find().deep.hasMore).toBe(true);
    h.db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('integrity-check', 1)");
  });

  it('opens an old backup read-only without creating an index, then builds on a writer open', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'raw-search-old-backup-')); directories.push(dir);
    const h = fixture(path.join(dir, 'source.db')); h.write('old');
    const backup = path.join(dir, 'backup.db'); h.db.run('VACUUM INTO ?', [backup]);
    const read = new Database(backup, { readonly: true });
    try {
      const bytes = readFileSync(backup);
      expect(new SessionSearch(read, { readOnly: true, toolUseIndexEnabled: true }).getToolUseIndexStatus()).toBe('disabled');
      expect(readFileSync(backup)).toEqual(bytes);
    } finally { read.close(); }
    const restored = fixture(backup); restored.enable();
    expect(restored.find().toolUses).toHaveLength(1);
  });

  it('uses a restored index read-only without repair or rebuilding at each open', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'raw-search-')); directories.push(dir);
    const h = fixture(path.join(dir, 'source.db')); h.write('old'); h.enable();
    const backup = path.join(dir, 'backup.db'); h.db.run('VACUUM INTO ?', [backup]);
    const read = new Database(backup, { readonly: true });
    try {
      const before = read.query('PRAGMA schema_version').get();
      const bytes = readFileSync(backup);
      const search = new SessionSearch(read, { readOnly: true, toolUseIndexEnabled: false });
      expect(search.searchToolUses('DB_CONN_1042').toolUses).toHaveLength(1);
      expect(read.query('PRAGMA schema_version').get()).toEqual(before);
      expect(readFileSync(backup)).toEqual(bytes); // temp FTS probes may write; main stays byte-identical
    } finally { read.close(); }
  });
});
