import { describe, expect, test } from 'bun:test';
import { bootstrapExternalMemorySchema } from '../../../src/services/external-memory/schema.js';

class RecordingPgClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    return { rows: [], rowCount: 0 };
  }
}

describe('external pgvector memory schema', () => {
  test('bootstraps pgvector tables, FTS index, and vector index in one transaction', async () => {
    const client = new RecordingPgClient();

    await bootstrapExternalMemorySchema(client, { vectorDimensions: 768 });

    const sql = client.queries.map(q => q.text).join('\n');
    expect(client.queries[0]?.text).toBe('BEGIN');
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claude_mem_external_memory_items');
    expect(sql).toContain('embedding vector(768)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_external_memory_items_content_search');
    expect(sql).toContain('USING GIN (content_search)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_external_memory_items_embedding_hnsw');
    expect(sql).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(sql).toContain('UNIQUE (memory_session_id, kind, content_hash)');
  });

  test('rolls back if schema creation fails', async () => {
    const client = new RecordingPgClient();
    client.query = async (text: string, values?: unknown[]) => {
      client.queries.push({ text, values });
      if (text.includes('CREATE TABLE')) {
        throw new Error('ddl failed');
      }
      return { rows: [], rowCount: 0 };
    };

    await expect(bootstrapExternalMemorySchema(client, { vectorDimensions: 1536 })).rejects.toThrow('ddl failed');
    expect(client.queries.map(q => q.text)).toContain('ROLLBACK');
  });

  test('rejects dimensions outside the pgvector HNSW index limit before opening a transaction', async () => {
    const client = new RecordingPgClient();

    await expect(bootstrapExternalMemorySchema(client, { vectorDimensions: 2001 })).rejects.toThrow(
      'pgvector dimensions must be an integer between 1 and 2000'
    );
    expect(client.queries).toEqual([]);
  });
});
