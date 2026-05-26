import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('Directives Store', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.db.close();
  });

  it('creates the directives table and indexes via migration', () => {
    const table = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directives'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('directives');

    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='directives'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_directives_status_project');
    expect(indexNames).toContain('idx_directives_status_scope');

    const version = store.db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(35) as { version: number } | undefined;
    expect(version?.version).toBe(35);
  });

  it('adds a global directive and lists it', () => {
    const { id } = store.addDirective('read files in full, never grep', 'global', null);
    expect(id).toBeGreaterThan(0);

    const directives = store.listActiveDirectives([], 25);
    expect(directives).toHaveLength(1);
    expect(directives[0].content).toBe('read files in full, never grep');
    expect(directives[0].scope).toBe('global');
    expect(directives[0].project).toBeNull();
    expect(directives[0].status).toBe('active');
  });

  it('always includes globals even when no projects are given', () => {
    store.addDirective('global rule', 'global', null);
    store.addDirective('project rule', 'project', 'claude-mem');

    const directives = store.listActiveDirectives([], 25);
    expect(directives.map(d => d.content)).toEqual(['global rule']);
  });

  it('includes project directives when the project is requested', () => {
    store.addDirective('global rule', 'global', null);
    store.addDirective('project rule', 'project', 'claude-mem');
    store.addDirective('other project rule', 'project', 'other-project');

    const directives = store.listActiveDirectives(['claude-mem'], 25);
    expect(directives.map(d => d.content).sort()).toEqual(['global rule', 'project rule']);
  });

  it('archives a directive and excludes it from the active list', () => {
    const { id } = store.addDirective('temporary rule', 'global', null);

    const archived = store.archiveDirective(id);
    expect(archived?.id).toBe(id);

    const directives = store.listActiveDirectives([], 25);
    expect(directives).toHaveLength(0);
  });

  it('returns null when archiving a directive that does not exist', () => {
    const result = store.archiveDirective(99999);
    expect(result).toBeNull();
  });

  it('orders directives by created_at_epoch ascending', () => {
    const first = store.addDirective('first', 'global', null);
    const second = store.addDirective('second', 'global', null);

    const directives = store.listActiveDirectives([], 25);
    expect(directives[0].id).toBe(first.id);
    expect(directives[1].id).toBe(second.id);
  });

  it('creates the directives table even when version 35 is already recorded', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());

    const collisionStore = new SessionStore(db);

    const table = collisionStore.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='directives'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('directives');

    const { id } = collisionStore.addDirective('survives the stale v35 row', 'global', null);
    expect(id).toBeGreaterThan(0);

    const directives = collisionStore.listActiveDirectives([], 25);
    expect(directives.map(d => d.content)).toEqual(['survives the stale v35 row']);

    collisionStore.db.close();
  });
});
