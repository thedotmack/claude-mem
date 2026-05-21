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
  const vectorDimensions = assertVectorDimensions(options.vectorDimensions);

  await client.query('BEGIN');
  try {
    await client.query(buildExternalMemorySchemaSql(vectorDimensions));
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
VALUES (${EXTERNAL_MEMORY_SCHEMA_VERSION}, 'external pgvector/valkey memory mirror')
ON CONFLICT (version) DO NOTHING;
`;
}
