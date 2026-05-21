// SPDX-License-Identifier: Apache-2.0

import type { PostgresQueryable } from '../../storage/postgres/utils.js';

export const EXTERNAL_MEMORY_SCHEMA_VERSION = 1;

export interface ExternalMemorySchemaOptions {
  vectorDimensions: number;
}

export async function bootstrapExternalMemorySchema(
  client: PostgresQueryable,
  options: ExternalMemorySchemaOptions
): Promise<void> {
  if (isPostgresPool(client)) {
    const poolClient = await client.connect();
    try {
      await bootstrapExternalMemorySchema(poolClient, options);
    } finally {
      poolClient.release();
    }
    return;
  }

  const vectorDimensions = assertVectorDimensions(options.vectorDimensions);

  await client.query('BEGIN');
  try {
    await client.query(buildExternalMemorySchemaSql(vectorDimensions));
    await assertEmbeddingColumnDimensions(client, vectorDimensions);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function assertVectorDimensions(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2_000) {
    throw new Error('pgvector dimensions must be an integer between 1 and 2000');
  }
  return value;
}

interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresQueryable & { release(): void }>;
}

function isPostgresPool(client: PostgresQueryable): client is PostgresPoolLike {
  const candidate = client as {
    connect?: unknown;
    release?: unknown;
    totalCount?: unknown;
    idleCount?: unknown;
    waitingCount?: unknown;
  };
  return (
    typeof candidate.connect === 'function'
    && typeof candidate.release !== 'function'
    && typeof candidate.totalCount === 'number'
    && typeof candidate.idleCount === 'number'
    && typeof candidate.waitingCount === 'number'
  );
}

async function assertEmbeddingColumnDimensions(client: PostgresQueryable, expectedDimensions: number): Promise<void> {
  const result = await client.query<{ embedding_type: string | null }>(`
    SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
    FROM pg_attribute a
    WHERE a.attrelid = 'claude_mem_external_memory_items'::regclass
      AND a.attname = 'embedding'
      AND NOT a.attisdropped
  `);

  const embeddingType = result.rows[0]?.embedding_type;
  const actualDimensions = typeof embeddingType === 'string' ? parseVectorDimensions(embeddingType) : null;
  if (actualDimensions === null) {
    throw new Error('Unable to verify pgvector embedding column dimensions for external memory schema');
  }
  if (actualDimensions !== expectedDimensions) {
    throw new Error(
      `Existing external memory embedding column uses vector(${actualDimensions}); set CLAUDE_MEM_PG_VECTOR_DIMENSIONS=${actualDimensions} or recreate the external memory schema before using vector(${expectedDimensions})`
    );
  }
}

function parseVectorDimensions(embeddingType: string): number | null {
  const match = /^vector\((\d+)\)$/.exec(embeddingType.trim());
  return match ? Number(match[1]) : null;
}

function buildExternalMemorySchemaSql(vectorDimensions: number): string {
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS claude_mem_external_schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claude_mem_external_memory_items (
  id BIGSERIAL PRIMARY KEY,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary')),
  type TEXT,
  title TEXT,
  subtitle TEXT,
  content TEXT NOT NULL,
  facts JSONB NOT NULL DEFAULT '[]'::jsonb,
  narrative TEXT,
  concepts JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_read JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_modified JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_number INTEGER,
  discovery_tokens INTEGER NOT NULL DEFAULT 0,
  source_sqlite_id INTEGER,
  content_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(${vectorDimensions}),
  content_search TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(subtitle, '') || ' ' || content || ' ' || coalesce(narrative, ''))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL,
  created_at_epoch BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (memory_session_id, kind, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_external_memory_items_project_created
  ON claude_mem_external_memory_items(project, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_memory_items_content_search
  ON claude_mem_external_memory_items USING GIN (content_search);

CREATE INDEX IF NOT EXISTS idx_external_memory_items_embedding_hnsw
  ON claude_mem_external_memory_items USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

INSERT INTO claude_mem_external_schema_migrations (version, description)
VALUES (${EXTERNAL_MEMORY_SCHEMA_VERSION}, 'external postgres/valkey memory')
ON CONFLICT (version) DO NOTHING;
`;
}
