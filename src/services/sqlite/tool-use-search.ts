import type { Database } from 'bun:sqlite';
import { checkAndRaiseSchemaWriterStampInTransaction, LATEST_SCHEMA_VERSION } from './connection.js';
import { buildFTSMatchQuery, buildSubstringClause, substringTerms, UNSEGMENTED_SCRIPT } from './search-query.js';
import { projectScopeSql, scopedProjects } from './project-read-keys.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveDateBound } from '../../shared/date-bounds.js';
import type { SearchOptions } from './types.js';

// A derived, optional index: its version does not change the tool_uses writer schema.
const VERSION = 1;
export const TOOL_USE_FTS_TRIGGERS = ['tool_uses_fts_ai', 'tool_uses_fts_ad', 'tool_uses_fts_au'];
export type ToolUseIndexStatus = 'ready' | 'building' | 'disabled' | 'not_ready' | 'unsupported' | 'error';
export interface ToolUseHit {
  id: number;
  tool_use_id: string;
  tool_name: string;
  project: string;
  content_session_id: string;
  platform_source: string;
  created_at_epoch: number;
  snippet: string;
}
export interface DeepSearchResult {
  deep: { status: ToolUseIndexStatus | 'ok' | 'not_applicable' | 'observation_error' | 'observations_found'; count: number; hasMore: boolean };
  toolUses: ToolUseHit[];
}
export function emptyDeepResult(status: DeepSearchResult['deep']['status']): DeepSearchResult {
  return { deep: { status, count: 0, hasMore: false }, toolUses: [] };
}

function exists(db: Database, name: string): boolean {
  return !!db.query('SELECT 1 FROM sqlite_master WHERE name = ?').get(name);
}

/** Read-only readiness check. Never builds an index on the search request path. */
export function toolUseIndexStatus(db: Database): ToolUseIndexStatus {
  if (!exists(db, 'tool_uses_fts')) return 'disabled';
  if (!exists(db, 'tool_uses_search_schema')) return 'not_ready';
  const version = db.query('SELECT version, state FROM tool_uses_search_schema WHERE id = 1').get() as { version: number; state: string } | null;
  if (version?.version !== VERSION || !TOOL_USE_FTS_TRIGGERS.every(name => exists(db, name))) return 'not_ready';
  return version.state === 'ready' ? 'ready' : 'building';
}

// While building, only rows at/below the committed cursor are indexed. The
// cursor and each batch commit together. New rows above it are picked up by a
// later batch; updates/deletes below it stay synchronized immediately.
const indexed = (row: 'old' | 'new') => `(SELECT state = 'ready' OR ${row}.id <= cursor FROM tool_uses_search_schema WHERE id = 1)`;
const TRIGGERS_SQL = `
CREATE TRIGGER tool_uses_fts_ai AFTER INSERT ON tool_uses WHEN ${indexed('new')} BEGIN
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response) VALUES(new.id, new.tool_input, new.tool_response);
END;
CREATE TRIGGER tool_uses_fts_ad AFTER DELETE ON tool_uses WHEN ${indexed('old')} BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    VALUES('delete', old.id, old.tool_input, old.tool_response);
END;
CREATE TRIGGER tool_uses_fts_au AFTER UPDATE OF id, tool_input, tool_response ON tool_uses
WHEN old.id IS NOT new.id OR old.tool_input IS NOT new.tool_input OR old.tool_response IS NOT new.tool_response BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    SELECT 'delete', old.id, old.tool_input, old.tool_response WHERE ${indexed('old')};
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response)
    SELECT new.id, new.tool_input, new.tool_response WHERE ${indexed('new')};
END;`;

function prepareToolUseIndex(db: Database, enabled: boolean): ToolUseIndexStatus {
  if (!enabled && !exists(db, 'tool_uses_fts') && !exists(db, 'tool_uses_search_schema')
    && !TOOL_USE_FTS_TRIGGERS.some(name => exists(db, name))) return 'disabled';
  if (enabled && toolUseIndexStatus(db) === 'ready') return 'ready';
  return db.transaction(() => {
    checkAndRaiseSchemaWriterStampInTransaction(db, LATEST_SCHEMA_VERSION);
    const existing = exists(db, 'tool_uses_search_schema')
      ? db.query('SELECT version FROM tool_uses_search_schema WHERE id = 1').get() as { version: number } | null : null;
    if (existing && existing.version > VERSION) throw new Error('Raw tool search index was created by a newer version');
    const status = toolUseIndexStatus(db);
    if (enabled && (status === 'ready' || status === 'building')) return status;
    // Missing triggers invalidate the cursor: restart the derived index under
    // the write lock. Never reattach delete triggers to a stale full index.
    for (const name of TOOL_USE_FTS_TRIGGERS) db.run(`DROP TRIGGER IF EXISTS ${name}`);
    db.run('DROP TABLE IF EXISTS tool_uses_fts');
    db.run('DROP TABLE IF EXISTS tool_uses_search_schema');
    if (!enabled) return 'disabled' as const;
    db.run(`CREATE VIRTUAL TABLE tool_uses_fts USING fts5(
      tool_input, tool_response, content='tool_uses', content_rowid='id', tokenize='unicode61'
    )`);
    db.run(`CREATE TABLE tool_uses_search_schema(
      id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('building', 'ready')), cursor INTEGER NOT NULL
    )`);
    db.run("INSERT INTO tool_uses_search_schema VALUES(1, ?, 'building', 0)", [VERSION]);
    db.run(TRIGGERS_SQL);
    return 'building' as const;
  }).immediate();
}

/** One bounded transaction. Also used by the synchronous fixture path. */
export function buildToolUseIndexBatch(db: Database): boolean {
  return db.transaction(() => {
    const state = db.query('SELECT state, cursor FROM tool_uses_search_schema WHERE id = 1').get() as {state: string; cursor: number};
    if (state.state === 'ready') return false;
    const last = db.query('SELECT max(id) AS id FROM (SELECT id FROM tool_uses WHERE id > ? ORDER BY id LIMIT 64)').get(state.cursor) as {id: number | null};
    if (last.id === null) {
      db.run("UPDATE tool_uses_search_schema SET state = 'ready' WHERE id = 1");
      return false;
    }
    db.run(`INSERT INTO tool_uses_fts(rowid, tool_input, tool_response)
      SELECT id, tool_input, tool_response FROM tool_uses WHERE id > ? AND id <= ? ORDER BY id`, [state.cursor, last.id]);
    db.run('UPDATE tool_uses_search_schema SET cursor = ? WHERE id = 1', [last.id]);
    return true;
  }).immediate();
}

/** Synchronous setup for isolated readers/tests; production uses the yielding path below. */
export function configureToolUseIndex(db: Database, enabled: boolean): ToolUseIndexStatus {
  const status = prepareToolUseIndex(db, enabled);
  if (status !== 'building') return status;
  while (buildToolUseIndexBatch(db)) { /* one atomic batch */ }
  return 'ready';
}

/** Worker-owned startup job, after core search is ready; no extra process or timer loop. */
export async function configureToolUseIndexAsync(db: Database, enabled: boolean, signal?: AbortSignal): Promise<ToolUseIndexStatus> {
  const status = prepareToolUseIndex(db, enabled);
  if (status !== 'building') return status;
  while (!signal?.aborted) {
    if (!buildToolUseIndexBatch(db)) return 'ready';
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return 'building'; // committed cursor and guarded triggers survive restart
}

/** Only already-stored, privacy-filtered bodies are indexed. No raw bodies leave this query. */
export function searchToolUses(db: Database, query: string, options: SearchOptions = {}): DeepSearchResult {
  const status = toolUseIndexStatus(db);
  if (status !== 'ready') return emptyDeepResult(status);
  if (!query.trim() || query.length > 4096) return emptyDeepResult('not_applicable');
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const projects = scopedProjects(options);
  if (projects.length) {
    const scope = projectScopeSql('t', projects, { includeMerged: false });
    conditions.push(scope.sql); params.push(...scope.params);
  }
  if (options.platformSource) {
    conditions.push('t.platform_source = ?'); params.push(normalizePlatformSource(options.platformSource));
  }
  for (const [bound, operator] of [['start', '>='], ['end', '<=']] as const) {
    if (options.dateRange?.[bound] !== undefined) {
      conditions.push(`t.created_at_epoch ${operator} ?`);
      params.push(resolveDateBound(options.dateRange[bound], bound));
    }
  }
  const cjk = UNSEGMENTED_SCRIPT.test(query);
  const match = cjk
    ? buildSubstringClause(query, ['t.tool_input', 't.tool_response'])
    : { clause: 'tool_uses_fts MATCH ?', params: [buildFTSMatchQuery(query)] };
  // LIMIT+1 is a bounded probe, not an exact corpus count or a second paging cursor.
  const limit = Math.min(10, Math.max(1, Math.floor(Number(options.limit) || 5)));
  const order = options.orderBy === 'date_asc' ? 't.created_at_epoch ASC, t.id ASC'
    : options.orderBy === 'date_desc' || cjk ? 't.created_at_epoch DESC, t.id DESC'
    : 'tool_uses_fts.rank, t.created_at_epoch DESC, t.id DESC';
  const term = substringTerms(query)[0] ?? query;
  // Substring snippets are centered around the first term in either column.
  // SQLite slices them before crossing the worker boundary, including on a 64 KiB field.
  const excerpt = cjk ? `
    COALESCE(substr(t.tool_input, max(1, instr(lower(t.tool_input), lower(?)) - 60), 200), '')
    || ' … ' || COALESCE(substr(t.tool_response, max(1, instr(lower(t.tool_response), lower(?)) - 60), 200), '')`
    : "snippet(tool_uses_fts, -1, '', '', ' … ', 24)";
  const rows = db.query(`SELECT t.id, t.tool_use_id, t.tool_name, t.project,
    t.content_session_id, t.platform_source, t.created_at_epoch, ${excerpt} AS snippet
    FROM tool_uses t ${cjk ? '' : 'JOIN tool_uses_fts ON tool_uses_fts.rowid = t.id'}
    WHERE ${[...conditions, match.clause].join(' AND ')} ORDER BY ${order} LIMIT ?
  `).all(...(cjk ? [term, term] : []), ...params, ...match.params, limit + 1) as ToolUseHit[];
  const toolUses = rows.slice(0, limit).map(row => ({ ...row,
    snippet: Array.from(row.snippet).slice(0, 480).join(''),
  }));
  return { deep: { status: 'ok', count: toolUses.length, hasMore: rows.length > limit }, toolUses };
}
