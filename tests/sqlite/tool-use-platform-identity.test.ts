import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { configureToolUseIndex } from '../../src/services/sqlite/tool-use-search.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';

const contentSessionId = 'shared-raw-session';
const toolUseId = 'shared-raw-call';

it('keeps overlapping host tool identities separate through native ingest, replay and raw search', async () => {
  const store = new SessionStore(':memory:');
  const queued: number[] = [];
  setIngestContext({
    dbManager: { getSessionStore: () => store } as never,
    sessionManager: { queueObservation: (id: number) => { queued.push(id); } } as never,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as never,
  });
  try {
    for (const platformSource of ['claude', 'codex', 'claude']) {
      const result = await ingestObservation({ contentSessionId, toolUseId, platformSource,
        toolName: 'Read', cwd: '/workspace/raw-project', toolInput: { file_path: 'src/config.ts' },
        toolResponse: `${platformSource} distinct evidence`,
      });
      expect(result.ok).toBe(true);
    }
    expect(queued).toHaveLength(3);
    const rows = store.queryToolUses({ contentSessionId });
    expect(rows).toHaveLength(2);
    const search = new SessionSearch(store.db, { toolUseIndexEnabled: true });
    for (const platform of ['claude', 'codex']) {
      const selected = store.getToolUsesByIds([toolUseId], { contentSessionId, platformSource: platform });
      expect(selected).toHaveLength(1);
      expect(selected[0].tool_response).toContain(`${platform} distinct evidence`);
      expect(search.searchToolUses('evidence', { platformSource: platform }).toolUses.map(row => row.id))
        .toEqual([selected[0].id]);
    }
  } finally { store.close(); }
});

it('links an observation only to the tool receipt from its platform', () => {
  const store = new SessionStore(':memory:');
  try {
    const ids: Record<string, number> = {};
    for (const platformSource of ['claude', 'codex']) {
      ids[platformSource] = store.upsertToolUse({ contentSessionId, toolUseId, platformSource,
        project: 'raw-project', toolName: 'Read', toolResponse: platformSource })!;
    }
    store.linkToolUsesToObservation({ contentSessionId, toolUseIds: [toolUseId],
      platformSource: 'codex', observationId: 22, memorySessionId: 'codex-memory' });
    store.linkToolUsesToObservation({ contentSessionId, toolUseIds: [toolUseId],
      observationId: 11, memorySessionId: 'claude-memory' });
    const rows = store.db.query('SELECT id, platform_source, observation_id, memory_session_id FROM tool_uses ORDER BY platform_source').all();
    expect(rows).toEqual([
      { id: ids.claude, platform_source: 'claude', observation_id: 11, memory_session_id: 'claude-memory' },
      { id: ids.codex, platform_source: 'codex', observation_id: 22, memory_session_id: 'codex-memory' },
    ]);
  } finally { store.close(); }
});

it('upgrades the legacy backup table without losing row IDs, receipt metadata, FTS, triggers or sequence history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-tool-platform-'));
  const file = join(directory, 'legacy.sqlite');
  let store = new SessionStore(file);
  try {
    // Recreate precisely the v51/v74 uniqueness boundary before seeding the
    // historical backup. The other production tables retain their real DDL.
    const table = store.db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_uses'").get() as { sql: string };
    const dependents = store.db.query("SELECT sql FROM sqlite_master WHERE tbl_name='tool_uses' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as Array<{ sql: string }>;
    store.db.run('DROP TABLE tool_uses');
    store.db.run(table.sql.replace(/UNIQUE\(platform_source, content_session_id, tool_use_id\)/, 'UNIQUE(content_session_id, tool_use_id)'));
    for (const item of dependents) store.db.run(item.sql);
    store.db.run('DELETE FROM schema_versions WHERE version > 74');
    store.db.run('PRAGMA user_version = 74');
    store.db.run(`INSERT INTO tool_uses
      (id, tool_use_id, content_session_id, project, platform_source, tool_name, tool_input, tool_response,
       observation_id, memory_session_id, or_generation_id, or_session_id, content_hash, created_at, created_at_epoch)
      VALUES (7, ?, ?, 'raw-project', 'claude', 'Read', '{"file":"config"}', 'legacy evidence',
        42, 'legacy-memory', 'generation-42', 'job:shared-raw-session', 'retained-hash', '2026-01-01T00:00:00.000Z', 1767225600000)`, [toolUseId, contentSessionId]);
    store.db.run("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'tool_uses'");
    configureToolUseIndex(store.db, true);
    store.db.run('CREATE INDEX retained_tool_input_index ON tool_uses(tool_name, id)');
    store.db.run('CREATE TABLE receipt_audit(id INTEGER)');
    store.db.run('CREATE TRIGGER retained_tool_insert AFTER INSERT ON tool_uses BEGIN INSERT INTO receipt_audit VALUES(new.id); END');
    const before = store.getToolUsesByIds([7])[0];
    store.close();
    store = new SessionStore(file);
    expect(store.getToolUsesByIds([7])[0]).toEqual(before);
    const id = store.upsertToolUse({ contentSessionId, toolUseId, platformSource: 'codex',
      project: 'raw-project', toolName: 'Read', toolResponse: 'new platform evidence' })!;
    expect(id).toBeGreaterThan(100);
    expect(store.queryToolUses({ contentSessionId })).toHaveLength(2);
    expect(store.db.query('SELECT id FROM receipt_audit').all()).toEqual([{ id }]);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name='retained_tool_input_index'").get()).not.toBeNull();
    const search = new SessionSearch(store.db);
    expect(search.searchToolUses('legacy', { platformSource: 'claude' }).toolUses.map(row => row.id)).toEqual([7]);
    expect(search.searchToolUses('new', { platformSource: 'codex' }).toolUses.map(row => row.id)).toEqual([id]);
    store.db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('integrity-check', 1)");
    store.close();
    store = new SessionStore(file);
    expect(store.getToolUsesByIds([7])[0]).toEqual(before);
    expect(store.upsertToolUse({ contentSessionId, toolUseId, platformSource: 'codex', project: 'raw-project', toolName: 'Read' })).toBe(id);
    expect(store.queryToolUses({ contentSessionId })).toHaveLength(2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
