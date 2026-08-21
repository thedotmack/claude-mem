import type { Database } from 'bun:sqlite';
import type { VectorDocKind } from './types.js';
import { DEFAULT_PLATFORM_SOURCE } from '../../shared/platform-source.js';

/**
 * One table per document kind.
 *
 * Chroma needed a single collection with a doc_type metadata field because it
 * has one namespace. SQLite does not, and three tables buy two things:
 *
 *  1. A real ON DELETE CASCADE to the owning row, so orphaned vectors are
 *     impossible rather than swept (#2864 orphaned observations on worktree
 *     cleanup).
 *  2. No duplicated metadata. Chroma copied project / merged_into_project /
 *     platform_source onto every document, which is exactly how they drifted
 *     out of step with SQLite. Scope is now reached by JOIN at query time.
 */
export interface VectorTableSpec {
  table: string;
  parent: string;
  /** JOIN chain from the vector table to whatever carries scope. */
  joinSql: string;
  /** Expression yielding the project for a row. */
  projectExpr: string;
  /** Expression yielding merged_into_project, when that column exists. */
  mergedExpr: string | null;
  /** Table+column that must exist for mergedExpr to be usable. */
  mergedRequires: [table: string, column: string] | null;
  /**
   * Expression yielding platform_source, when that column exists. NULL and ''
   * both resolve to DEFAULT_PLATFORM_SOURCE rather than dropping out, so rows
   * captured before the column was populated still match a 'claude' scope.
   */
  platformExpr: string | null;
  platformRequires: [table: string, column: string] | null;
}

const PLATFORM_SOURCE_EXPR =
  `COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}')`;

/**
 * Scope does not live in the same place for every kind, which is why this is
 * data rather than a hardcoded WHERE clause:
 *   observations / session_summaries carry `project` themselves and reach
 *   platform_source through sdk_sessions.memory_session_id;
 *   user_prompts carry neither and reach both through the foreign key
 *   sdk_sessions.id = user_prompts.session_db_id.
 *
 * The prompt join is an INNER join, so a prompt whose session_db_id is NULL —
 * possible only on a row the schema-34 migration could not resolve to a
 * session — is not reachable by a scoped query.
 */
export const VECTOR_TABLES: Record<VectorDocKind, VectorTableSpec> = {
  observation: {
    table: 'vec_observation_docs',
    parent: 'observations',
    joinSql:
      'JOIN observations p ON p.id = v.sqlite_id ' +
      'LEFT JOIN sdk_sessions s ON s.memory_session_id = p.memory_session_id',
    projectExpr: 'p.project',
    mergedExpr: 'p.merged_into_project',
    mergedRequires: ['observations', 'merged_into_project'],
    platformExpr: PLATFORM_SOURCE_EXPR,
    platformRequires: ['sdk_sessions', 'platform_source'],
  },
  summary: {
    table: 'vec_summary_docs',
    parent: 'session_summaries',
    joinSql:
      'JOIN session_summaries p ON p.id = v.sqlite_id ' +
      'LEFT JOIN sdk_sessions s ON s.memory_session_id = p.memory_session_id',
    projectExpr: 'p.project',
    mergedExpr: 'p.merged_into_project',
    mergedRequires: ['session_summaries', 'merged_into_project'],
    platformExpr: PLATFORM_SOURCE_EXPR,
    platformRequires: ['sdk_sessions', 'platform_source'],
  },
  prompt: {
    table: 'vec_prompt_docs',
    parent: 'user_prompts',
    joinSql:
      'JOIN user_prompts p ON p.id = v.sqlite_id ' +
      'JOIN sdk_sessions s ON s.id = p.session_db_id',
    projectExpr: 's.project',
    mergedExpr: null,
    mergedRequires: null,
    platformExpr: PLATFORM_SOURCE_EXPR,
    platformRequires: ['sdk_sessions', 'platform_source'],
  },
};

/**
 * Column presence is checked at runtime, not assumed.
 *
 * merged_into_project and platform_source arrive via ALTER TABLE migrations, so
 * a store that has not run them yet is a real state a worker can open. Querying
 * a column that is not there is a hard SQL error, and search failing closed on
 * an old store would be a worse bug than not scoping by it.
 *
 * One column is deliberately NOT probed: user_prompts.session_db_id, named
 * unconditionally in the prompt joinSql above. It predates every store this
 * code can open — SessionStore creates user_prompts with it and migrates older
 * tables to it before any query runs — so a probe would only ever return true.
 */
export function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[];
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

function createTableSql(table: string, parent: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      doc_id       TEXT PRIMARY KEY,
      sqlite_id    INTEGER NOT NULL,
      field_type   TEXT NOT NULL,
      fact_index   INTEGER,
      content_hash TEXT NOT NULL,
      model_id     TEXT NOT NULL,
      dims         INTEGER NOT NULL,
      embedding    BLOB NOT NULL,
      FOREIGN KEY (sqlite_id) REFERENCES ${parent}(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ix_${table}_sqlite ON ${table}(sqlite_id);
    CREATE INDEX IF NOT EXISTS ix_${table}_model  ON ${table}(model_id);
  `;
}

/** Idempotent. Safe on every worker boot. */
export function ensureVectorSchema(db: Database): void {
  for (const { table, parent } of Object.values(VECTOR_TABLES)) {
    db.run(createTableSql(table, parent));
  }
}

/** float32[] -> BLOB. Little-endian, which is every platform we ship on. */
export function encodeEmbedding(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * BLOB -> float32[]. Copies, because the buffer is owned by the SQLite
 * statement and is invalidated on the next step().
 */
export function decodeEmbedding(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
