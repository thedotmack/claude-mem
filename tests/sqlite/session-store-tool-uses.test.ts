import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MAX_TOOL_PAYLOAD_BYTES, truncatePayload } from '../../src/services/sqlite/tool-uses.js';

interface TableColumnInfo {
  name: string;
}

interface SchemaVersionRow {
  version: number;
}

function toolUsesColumns(db: Database): string[] {
  return (db.query('PRAGMA table_info(tool_uses)').all() as TableColumnInfo[]).map(col => col.name);
}

function hasTable(db: Database, name: string): boolean {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(name) as unknown[]).length > 0;
}

/**
 * Seed a pre-v51 database: the constructor chain fills in everything else, but
 * neither `tool_uses` nor the v51 stamp exists yet.
 */
function seedLegacyDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
    .run(50, new Date().toISOString());
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    toolUseId: 'toolu_01',
    contentSessionId: 'content-session-a',
    project: 'claude-mem',
    toolName: 'Read',
    toolInput: '{"file_path":"/tmp/a.ts"}',
    toolResponse: '{"ok":true}',
    cwd: '/workspace/claude-mem',
    promptNumber: 3,
    ...overrides,
  } as Parameters<SessionStore['upsertToolUse']>[0];
}

describe('SessionStore tool_uses (v51)', () => {
  let store: SessionStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  describe('migration', () => {
    it('creates tool_uses on a fresh database with the frozen column set', () => {
      const db = new Database(':memory:');
      store = new SessionStore(db);

      expect(hasTable(db, 'tool_uses')).toBe(true);

      const columns = toolUsesColumns(db);
      for (const expected of [
        'id', 'tool_use_id', 'content_session_id', 'memory_session_id', 'session_db_id',
        'project', 'platform_source', 'tool_name', 'tool_input', 'tool_response', 'cwd',
        'prompt_number', 'agent_type', 'agent_id', 'observation_id',
        'or_generation_id', 'or_session_id', 'content_hash', 'created_at', 'created_at_epoch',
      ]) {
        expect(columns).toContain(expected);
      }
    });

    it('carries the Receipt-frozen OR join columns and no cost column', () => {
      const db = new Database(':memory:');
      store = new SessionStore(db);

      const columns = toolUsesColumns(db);
      expect(columns).toContain('or_generation_id');
      expect(columns).toContain('or_session_id');
      // Receipt freeze 2026-09-06: dollars live on OR stamps / the spend log.
      expect(columns).not.toContain('cost_usd');
      expect(columns.some(c => c.includes('cost'))).toBe(false);
      expect(columns.some(c => c.includes('micros'))).toBe(false);
    });

    it('migrates an existing pre-v51 database and stamps schema version 51', () => {
      const db = new Database(':memory:');
      seedLegacyDb(db);
      expect(hasTable(db, 'tool_uses')).toBe(false);

      store = new SessionStore(db);

      expect(hasTable(db, 'tool_uses')).toBe(true);
      const versions = (db.query('SELECT version FROM schema_versions').all() as SchemaVersionRow[])
        .map(row => row.version);
      expect(versions).toContain(51);
    });

    it('leaves pending_messages intact (queue is not repurposed)', () => {
      const db = new Database(':memory:');
      store = new SessionStore(db);
      expect(hasTable(db, 'pending_messages')).toBe(true);
    });

    it('re-running the constructor over the same database is a no-op', () => {
      const db = new Database(':memory:');
      const first = new SessionStore(db);
      first.upsertToolUse(baseInput());

      // Second SessionStore over the same handle re-runs the whole chain.
      const second = new SessionStore(db);
      store = second;

      expect(second.queryToolUses({ contentSessionId: 'content-session-a' })).toHaveLength(1);
    });
  });

  describe('upsertToolUse', () => {
    it('inserts a row and returns its id', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.upsertToolUse(baseInput());

      expect(id).toBeGreaterThan(0);

      const [row] = store.queryToolUses({ contentSessionId: 'content-session-a' });
      expect(row.tool_name).toBe('Read');
      expect(row.tool_input).toBe('{"file_path":"/tmp/a.ts"}');
      expect(row.tool_response).toBe('{"ok":true}');
      expect(row.project).toBe('claude-mem');
      expect(row.platform_source).toBe('claude');
      expect(row.content_hash).toBeTruthy();
      expect(row.observation_id).toBeNull();
    });

    it('is idempotent on replay of the same (content_session_id, tool_use_id)', () => {
      store = new SessionStore(new Database(':memory:'));
      const first = store.upsertToolUse(baseInput());
      const second = store.upsertToolUse(baseInput());

      expect(second).toBe(first);
      expect(store.queryToolUses({ contentSessionId: 'content-session-a' })).toHaveLength(1);
    });

    it('lets a replay fill in a tool_response the first write lacked', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolResponse: null }));
      store.upsertToolUse(baseInput({ toolResponse: '{"ok":true}' }));

      const [row] = store.queryToolUses({ contentSessionId: 'content-session-a' });
      expect(row.tool_response).toBe('{"ok":true}');
    });

    it('treats the same tool_use_id in a different session as a distinct row', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput());
      store.upsertToolUse(baseInput({ contentSessionId: 'content-session-b' }));

      expect(store.queryToolUses({})).toHaveLength(2);
    });

    it('skips a tool event with no tool_use_id rather than inserting a duplicate-prone row', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.upsertToolUse(baseInput({ toolUseId: '' }))).toBeNull();
      expect(store.queryToolUses({})).toHaveLength(0);
    });

    it('stores the OR join keys when a stamper supplies them', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({
        orGenerationId: 'gen-abc123',
        orSessionId: 'job:content-session-a',
      }));

      const [row] = store.queryToolUses({});
      expect(row.or_generation_id).toBe('gen-abc123');
      expect(row.or_session_id).toBe('job:content-session-a');
    });

    it('truncates an oversized payload at the soft cap with a marker', () => {
      store = new SessionStore(new Database(':memory:'));
      const huge = 'x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 5000);
      store.upsertToolUse(baseInput({ toolResponse: huge }));

      const [row] = store.queryToolUses({});
      expect(row.tool_response!.length).toBeLessThan(huge.length);
      expect(row.tool_response).toContain('[truncated:');
    });

    it('never splits a multi-byte character when truncating', () => {
      const value = '€'.repeat(MAX_TOOL_PAYLOAD_BYTES); // 3 bytes each
      const truncated = truncatePayload(value);
      expect(truncated).toContain('[truncated:');
      expect(truncated.includes('�')).toBe(false);
    });
  });

  describe('linkToolUsesToObservation', () => {
    it('links the named tool uses and backfills memory_session_id', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolUseId: 'toolu_01' }));
      store.upsertToolUse(baseInput({ toolUseId: 'toolu_02' }));

      const updated = store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: ['toolu_01', 'toolu_02'],
        observationId: 4242,
        memorySessionId: 'memory-session-a',
      });

      expect(updated).toBe(2);
      for (const row of store.queryToolUses({})) {
        expect(row.observation_id).toBe(4242);
        expect(row.memory_session_id).toBe('memory-session-a');
      }
    });

    it('does not steal an existing observation link', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput());
      store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: ['toolu_01'],
        observationId: 1,
      });
      store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: ['toolu_01'],
        observationId: 2,
      });

      const [row] = store.queryToolUses({});
      expect(row.observation_id).toBe(1);
    });

    it('ignores an empty id list', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.linkToolUsesToObservation({
        contentSessionId: 'content-session-a',
        toolUseIds: [],
        observationId: 1,
      })).toBe(0);
    });
  });

  describe('getToolUsesByIds', () => {
    it('fetches by numeric row id', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.upsertToolUse(baseInput())!;

      const rows = store.getToolUsesByIds([id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_use_id).toBe('toolu_01');
    });

    it('fetches by opaque tool_use_id string', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput());

      const rows = store.getToolUsesByIds(['toolu_01']);
      expect(rows).toHaveLength(1);
    });

    it('applies a project filter', () => {
      store = new SessionStore(new Database(':memory:'));
      const id = store.upsertToolUse(baseInput())!;

      expect(store.getToolUsesByIds([id], { project: 'claude-mem' })).toHaveLength(1);
      expect(store.getToolUsesByIds([id], { project: 'other-project' })).toHaveLength(0);
    });

    it('returns [] for an empty or unusable id list', () => {
      store = new SessionStore(new Database(':memory:'));
      expect(store.getToolUsesByIds([])).toEqual([]);
      expect(store.getToolUsesByIds(['   '])).toEqual([]);
    });
  });

  describe('queryToolUses / countToolUses', () => {
    it('filters by tool_name and orders newest first', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolUseId: 'a', toolName: 'Read', createdAtEpoch: 1000 }));
      store.upsertToolUse(baseInput({ toolUseId: 'b', toolName: 'Edit', createdAtEpoch: 2000 }));
      store.upsertToolUse(baseInput({ toolUseId: 'c', toolName: 'Read', createdAtEpoch: 3000 }));

      const reads = store.queryToolUses({ toolName: 'Read' });
      expect(reads.map(r => r.tool_use_id)).toEqual(['c', 'a']);
    });

    it('counts DISTINCT tool_use_id per tool for Receipt tallies', () => {
      store = new SessionStore(new Database(':memory:'));
      store.upsertToolUse(baseInput({ toolUseId: 'a', toolName: 'Read' }));
      store.upsertToolUse(baseInput({ toolUseId: 'a', toolName: 'Read' })); // replay
      store.upsertToolUse(baseInput({ toolUseId: 'b', toolName: 'Read' }));
      store.upsertToolUse(baseInput({ toolUseId: 'c', toolName: 'Edit' }));

      expect(store.countToolUses({ contentSessionId: 'content-session-a' })).toEqual([
        { tool_name: 'Read', uses: 2 },
        { tool_name: 'Edit', uses: 1 },
      ]);
    });
  });
});
