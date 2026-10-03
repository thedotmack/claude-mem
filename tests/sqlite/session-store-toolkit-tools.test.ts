import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import {
  findToolkitToolBySignature,
  getToolkitToolByName,
  insertToolkitTool,
  listToolkitTools,
  searchToolkitTools,
  updateToolkitTool,
  type InsertToolkitToolInput,
} from '../../src/services/sqlite/toolkit-tools.js';

interface SchemaVersionRow {
  version: number;
}

function hasTable(db: Database, name: string): boolean {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(name) as unknown[]).length > 0;
}

function schemaVersions(db: Database): number[] {
  return (db.query('SELECT version FROM schema_versions').all() as SchemaVersionRow[]).map(row => row.version);
}

/**
 * Seed a database that predates v62: the constructor chain fills in everything
 * else, but neither `toolkit_tools` nor the v62 stamp exists yet.
 */
function seedPreToolkitDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
    .run(60, new Date().toISOString());
}

function toolInput(overrides: Partial<InsertToolkitToolInput> = {}): InsertToolkitToolInput {
  return {
    name: 'git-status-diff',
    description: 'Use this when you need the working tree status and its diff together.',
    runtime: 'bash',
    parameters: [{ name: 'path', description: 'Repository to inspect', required: false, example: '.' }],
    primarySignature: 'Bash:git status → Bash:git diff',
    memberSignatures: ['Bash:git status → Bash:git diff', 'Bash:git status → Bash:git diff+'],
    occurrenceCount: 9,
    sessionCount: 4,
    projects: ['claude-mem', 'other-repo'],
    scope: 'global',
    project: null,
    status: 'live',
    riskLevel: 'low',
    createdAtEpoch: 1_700_000_000_000,
    ...overrides,
  };
}

describe('SessionStore toolkit_tools (v62)', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  describe('migration', () => {
    it('creates toolkit_tools on a fresh database and stamps schema version 62', () => {
      store = new SessionStore(new Database(':memory:'));

      expect(hasTable(store.db, 'toolkit_tools')).toBe(true);
      const version = store.db.query(
        'SELECT version FROM schema_versions WHERE version = 62',
      ).get() as { version: number } | null;
      expect(version?.version).toBe(62);
    });

    it('migrates a database that predates v62, without claiming v61', () => {
      const db = new Database(':memory:');
      seedPreToolkitDb(db);
      expect(hasTable(db, 'toolkit_tools')).toBe(false);

      store = new SessionStore(db);

      expect(hasTable(db, 'toolkit_tools')).toBe(true);
      const versions = schemaVersions(db);
      expect(versions).toContain(62);
      // v61 is reserved by the unmerged feat/work-state branch.
      expect(versions).not.toContain(61);
    });

    it('declares no foreign keys', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.db.query('PRAGMA foreign_key_list(toolkit_tools)').all()).toEqual([]);
    });

    it('re-running the constructor over the same database is a no-op', () => {
      const db = new Database(':memory:');
      const first = new SessionStore(db);
      insertToolkitTool(first.db, toolInput());

      // Second SessionStore over the same handle re-runs the whole chain.
      const second = new SessionStore(db);
      store = second;

      expect(listToolkitTools(second.db)).toHaveLength(1);
      expect(schemaVersions(second.db).filter(version => version === 62)).toHaveLength(1);
    });
  });

  describe('insertToolkitTool / updateToolkitTool', () => {
    it('round-trips every field through insert and update', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = insertToolkitTool(store.db, toolInput());
      expect(id).toBeGreaterThan(0);

      const inserted = getToolkitToolByName(store.db, 'git-status-diff')!;
      expect(inserted.id).toBe(id);
      expect(inserted.description).toBe('Use this when you need the working tree status and its diff together.');
      expect(inserted.runtime).toBe('bash');
      expect(JSON.parse(inserted.parameters)).toEqual([
        { name: 'path', description: 'Repository to inspect', required: false, example: '.' },
      ]);
      expect(inserted.primary_signature).toBe('Bash:git status → Bash:git diff');
      expect(JSON.parse(inserted.member_signatures)).toEqual([
        'Bash:git status → Bash:git diff',
        'Bash:git status → Bash:git diff+',
      ]);
      expect(inserted.occurrence_count).toBe(9);
      expect(inserted.session_count).toBe(4);
      expect(JSON.parse(inserted.projects)).toEqual(['claude-mem', 'other-repo']);
      expect(inserted.scope).toBe('global');
      expect(inserted.project).toBeNull();
      expect(inserted.status).toBe('live');
      expect(inserted.risk_level).toBe('low');
      expect(inserted.failure_reason).toBeNull();
      expect(inserted.generation_attempts).toBe(0);
      expect(inserted.created_at_epoch).toBe(1_700_000_000_000);
      expect(inserted.created_at).toBe(new Date(1_700_000_000_000).toISOString());
      expect(inserted.updated_at_epoch).toBe(1_700_000_000_000);

      const updatedParameters = [
        { name: 'repo', description: 'Repository to inspect', required: true, example: '.' },
        { name: 'stat-only', description: 'Print only the diffstat', required: false, example: 'true' },
      ];
      const updated = updateToolkitTool(store.db, id, {
        name: 'git-status-and-diff',
        runtime: 'python',
        parameters: updatedParameters,
        occurrenceCount: 14,
        sessionCount: 6,
        memberSignatures: ['Bash:git status → Bash:git diff', 'Bash:git status → Read'],
        projects: ['claude-mem'],
        scope: 'project',
        project: 'claude-mem',
        status: 'blocked',
        riskLevel: 'high',
        failureReason: 'destructive:git-reset-hard',
        generationAttempts: 1,
      });

      expect(updated.id).toBe(id);
      expect(updated.name).toBe('git-status-and-diff');
      expect(updated.runtime).toBe('python');
      expect(JSON.parse(updated.parameters)).toEqual(updatedParameters);
      expect(updated.occurrence_count).toBe(14);
      expect(updated.session_count).toBe(6);
      expect(JSON.parse(updated.member_signatures)).toEqual(['Bash:git status → Bash:git diff', 'Bash:git status → Read']);
      expect(JSON.parse(updated.projects)).toEqual(['claude-mem']);
      expect(updated.scope).toBe('project');
      expect(updated.project).toBe('claude-mem');
      expect(updated.status).toBe('blocked');
      expect(updated.risk_level).toBe('high');
      expect(updated.failure_reason).toBe('destructive:git-reset-hard');
      expect(updated.generation_attempts).toBe(1);
      expect(updated.updated_at_epoch).toBeGreaterThan(updated.created_at_epoch);
      expect(updated.updated_at).toBe(new Date(updated.updated_at_epoch).toISOString());
      // Fields the patch left out keep their stored values.
      expect(updated.description).toBe(inserted.description);
      expect(updated.primary_signature).toBe('Bash:git status → Bash:git diff');
      expect(updated.created_at).toBe(inserted.created_at);
      expect(updated.created_at_epoch).toBe(1_700_000_000_000);

      // The returned row is what a fresh read sees, under the new name only; `null` clears a column.
      expect(getToolkitToolByName(store.db, 'git-status-and-diff')).toEqual(updated);
      expect(getToolkitToolByName(store.db, 'git-status-diff')).toBeNull();
      expect(updateToolkitTool(store.db, id, { status: 'live', failureReason: null }).failure_reason).toBeNull();
    });

    it('throws when updating an id that has no row', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(() => updateToolkitTool(store!.db, 999, { status: 'live' })).toThrow('toolkit_tools has no row with id 999');
    });

    it('rejects a second row for the same primary signature', () => {
      store = new SessionStore(new Database(':memory:'));
      insertToolkitTool(store.db, toolInput());
      expect(() => insertToolkitTool(store!.db, toolInput({ name: 'another-name' }))).toThrow();
    });

    it('allows any number of unnamed rows (failed before a name was generated)', () => {
      store = new SessionStore(new Database(':memory:'));
      insertToolkitTool(store.db, toolInput({ name: null, primarySignature: 'sig-a', memberSignatures: ['sig-a'], status: 'failed' }));
      insertToolkitTool(store.db, toolInput({ name: null, primarySignature: 'sig-b', memberSignatures: ['sig-b'], status: 'failed' }));
      expect(listToolkitTools(store.db, { status: 'failed' })).toHaveLength(2);
    });
  });

  describe('findToolkitToolBySignature', () => {
    it('matches a non-primary member signature as well as the primary', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = insertToolkitTool(store.db, toolInput());

      expect(findToolkitToolBySignature(store.db, 'Bash:git status → Bash:git diff+')?.id).toBe(id);
      expect(findToolkitToolBySignature(store.db, 'Bash:git status → Bash:git diff')?.id).toBe(id);
      expect(findToolkitToolBySignature(store.db, 'Bash:git status')).toBeNull();
    });

    it('prefers the row whose primary the signature is over an older row listing it as a member', () => {
      store = new SessionStore(new Database(':memory:'));
      insertToolkitTool(store.db, toolInput({ name: 'older', primarySignature: 'sig-x', memberSignatures: ['sig-x', 'sig-y'] }));
      const ownerId = insertToolkitTool(store.db, toolInput({ name: 'owner', primarySignature: 'sig-y', memberSignatures: ['sig-y'] }));

      expect(findToolkitToolBySignature(store.db, 'sig-y')?.id).toBe(ownerId);
    });
  });

  describe('searchToolkitTools / listToolkitTools', () => {
    function seedCatalog(db: Database): void {
      insertToolkitTool(db, toolInput({
        name: 'git-status-diff', description: 'Use this when checking git status and diff',
        primarySignature: 'sig-global', memberSignatures: ['sig-global'], occurrenceCount: 9,
      }));
      insertToolkitTool(db, toolInput({
        name: 'git-deploy-alpha', description: 'Use this when deploying alpha with git',
        primarySignature: 'sig-alpha', memberSignatures: ['sig-alpha'], occurrenceCount: 12,
        projects: ['alpha'], scope: 'project', project: 'alpha',
      }));
      insertToolkitTool(db, toolInput({
        name: 'git-deploy-beta', description: 'Use this when deploying beta with git',
        primarySignature: 'sig-beta', memberSignatures: ['sig-beta'], occurrenceCount: 7,
        projects: ['beta'], scope: 'project', project: 'beta',
      }));
      insertToolkitTool(db, toolInput({
        name: 'git-force-push', description: 'Use this when force pushing with git',
        primarySignature: 'sig-blocked', memberSignatures: ['sig-blocked'], occurrenceCount: 30,
        status: 'blocked', riskLevel: 'high',
      }));
      insertToolkitTool(db, toolInput({
        name: 'git-broken', description: 'Use this when git fails',
        primarySignature: 'sig-failed', memberSignatures: ['sig-failed'], occurrenceCount: 40,
        status: 'failed', failureReason: 'parse',
      }));
    }

    const names = (rows: Array<{ name: string | null }>): Array<string | null> => rows.map(row => row.name);

    it('returns only live tools that are global or belong to the given project', () => {
      store = new SessionStore(new Database(':memory:'));
      seedCatalog(store.db);

      expect(names(searchToolkitTools(store.db, { query: 'git', project: 'alpha', limit: 10 })))
        .toEqual(['git-deploy-alpha', 'git-status-diff']);
      expect(names(searchToolkitTools(store.db, { query: 'git', project: 'beta', limit: 10 })))
        .toEqual(['git-status-diff', 'git-deploy-beta']);
      // Without a project, only global tools are offered.
      expect(names(searchToolkitTools(store.db, { query: 'git', limit: 10 })))
        .toEqual(['git-status-diff']);
    });

    it('requires every word in the name or description, case-insensitively, with literal wildcards', () => {
      store = new SessionStore(new Database(':memory:'));
      seedCatalog(store.db);

      expect(names(searchToolkitTools(store.db, { query: 'STATUS diff', limit: 10 }))).toEqual(['git-status-diff']);
      expect(searchToolkitTools(store.db, { query: 'status deploying', project: 'alpha', limit: 10 })).toEqual([]);
      // Unescaped, `_` and `%` would match "git-status-diff".
      expect(searchToolkitTools(store.db, { query: 'git_status', limit: 10 })).toEqual([]);
      expect(searchToolkitTools(store.db, { query: 'git%diff', limit: 10 })).toEqual([]);
    });

    it('uses only the leading SessionSearch.MAX_SUBSTRING_TERMS distinct words of a huge query', () => {
      store = new SessionStore(new Database(':memory:'));
      const keptWords = Array.from({ length: SessionSearch.MAX_SUBSTRING_TERMS }, (_, i) => `term${i}`);
      insertToolkitTool(store.db, toolInput({ description: `Use this when ${keptWords.join(' ')}` }));
      // 1,200 distinct words: uncapped, the ANDed LIKE groups overflow SQLite
      // ("Expression tree is too large (maximum depth 1000)").
      const words = Array.from({ length: 1200 }, (_, i) => `term${i}`);

      expect(names(searchToolkitTools(store.db, { query: words.join(' '), limit: 10 }))).toEqual(['git-status-diff']);
      // The leading words are the ones kept, so the same words in reverse order miss.
      expect(searchToolkitTools(store.db, { query: [...words].reverse().join(' '), limit: 10 })).toEqual([]);
    });

    it('caps results at the limit and rejects a limit that is not a positive integer', () => {
      store = new SessionStore(new Database(':memory:'));
      seedCatalog(store.db);

      expect(names(searchToolkitTools(store.db, { query: 'git', project: 'alpha', limit: 1 }))).toEqual(['git-deploy-alpha']);
      expect(() => searchToolkitTools(store!.db, { query: 'git', limit: 0 })).toThrow('limit must be a positive integer');
      expect(() => searchToolkitTools(store!.db, { query: 'git', limit: 2.5 })).toThrow('limit must be a positive integer');
    });

    it('lists by status and by project visibility, most-used first', () => {
      store = new SessionStore(new Database(':memory:'));
      seedCatalog(store.db);

      expect(names(listToolkitTools(store.db))).toEqual([
        'git-broken', 'git-force-push', 'git-deploy-alpha', 'git-status-diff', 'git-deploy-beta',
      ]);
      expect(names(listToolkitTools(store.db, { status: 'live' })))
        .toEqual(['git-deploy-alpha', 'git-status-diff', 'git-deploy-beta']);
      expect(names(listToolkitTools(store.db, { status: 'live', project: 'beta' })))
        .toEqual(['git-status-diff', 'git-deploy-beta']);
      expect(names(listToolkitTools(store.db, { status: 'blocked' }))).toEqual(['git-force-push']);
    });
  });
});
