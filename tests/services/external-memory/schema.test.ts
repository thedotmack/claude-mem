import { describe, expect, test } from 'bun:test';
import { bootstrapExternalMemorySchema } from '../../../src/services/external-memory/schema.js';

class RecordingPgClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];
  embeddingType = 'vector(768)';

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    if (text.includes('format_type(a.atttypid, a.atttypmod)')) {
      return { rows: [{ embedding_type: this.embeddingType }], rowCount: 1 };
    }
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

  test('uses a dedicated pool client so schema DDL is wrapped by one transaction', async () => {
    const poolClient = new RecordingPgClient();
    let released = false;
    const pool = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      async query() {
        throw new Error('pool.query should not be used for transactional schema bootstrap');
      },
      async connect() {
        return {
          query: poolClient.query.bind(poolClient),
          release() {
            released = true;
          },
        };
      },
    };

    await bootstrapExternalMemorySchema(pool, { vectorDimensions: 768 });

    expect(poolClient.queries[0]?.text).toBe('BEGIN');
    expect(poolClient.queries.at(-1)?.text).toBe('COMMIT');
    expect(released).toBe(true);
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

  test('rolls back with a clear error when an existing embedding column has different dimensions', async () => {
    const client = new RecordingPgClient();
    client.embeddingType = 'vector(1536)';

    await expect(bootstrapExternalMemorySchema(client, { vectorDimensions: 768 })).rejects.toThrow(
      'Existing external memory embedding column uses vector(1536)'
    );
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
