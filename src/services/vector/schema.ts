import type { Database } from 'bun:sqlite';
import type { VectorDocKind } from './types.js';

/**
 * One table per document kind.
 *
 * Chroma needed a single collection with a doc_type metadata field because it
 * has one namespace. SQLite does not, and three tables buy two things the
 * single-collection shape could not:
 *
 *  1. A real ON DELETE CASCADE to the owning row. Orphaned vectors were a
 *     standing class of bug (#2864 orphaned observations on worktree cleanup);
 *     with a foreign key the database enforces it instead of a sweep job.
 *  2. No duplicated metadata. project / merged_into_project / platform_source
 *     stay in the base tables and are reached by JOIN at query time. That
 *     structurally removes the whole family of "SQLite was updated, the index
 *     copy went stale" bugs — including remap_project, which never forwarded
 *     to Chroma at all (SyncApply.applyRemapProject takes no chromaJobs).
 *
 * PRAGMA foreign_keys = ON is already applied unconditionally in
 * sqlite/connection.ts, so the cascade is live with no pragma change.
 */
export const VECTOR_TABLES: Record<VectorDocKind, { table: string; parent: string }> = {
  observation: { table: 'vec_observation_docs', parent: 'observations' },
  summary:     { table: 'vec_summary_docs',     parent: 'session_summaries' },
  prompt:      { table: 'vec_prompt_docs',      parent: 'user_prompts' },
};

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

/** Idempotent. Safe to call on every worker boot. */
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
 * BLOB -> float32[]. Copies, because the underlying buffer is owned by the
 * SQLite statement and is invalidated on the next step().
 */
export function decodeEmbedding(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
