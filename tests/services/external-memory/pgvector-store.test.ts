import { describe, expect, test } from 'bun:test';
import { PgvectorMemoryStore } from '../../../src/services/external-memory/pgvector-store.js';

class FakePgClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    if (text.includes('RETURNING id, created_at_epoch')) {
      return { rows: [{ id: 42, created_at_epoch: 1_700_000_000_000 }], rowCount: 1 };
    }
    if (text.includes('ORDER BY embedding <=>')) {
      return { rows: [{ id: 42, content: 'vector hit', created_at_epoch: 1 }], rowCount: 1 };
    }
    if (text.includes('content_search @@')) {
      return { rows: [{ id: 43, content: 'text hit', created_at_epoch: 2 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const observation = {
  sqliteId: 7,
  memorySessionId: 'memory-session-1',
  project: 'claude-mem',
  type: 'decision',
  title: 'Use external store',
  subtitle: 'pgvector + valkey',
  facts: ['SQLite remains default'],
  narrative: 'External memory is mirrored into pgvector for shared recall.',
  concepts: ['storage', 'pgvector'],
  filesRead: ['CLAUDE.md'],
  filesModified: ['src/services/external-memory/pgvector-store.ts'],
  promptNumber: 3,
  discoveryTokens: 123,
  createdAtEpoch: 1_700_000_000_000,
  embedding: [0.1, 0.2, 0.3],
};

describe('PgvectorMemoryStore', () => {
  test('upserts observations with content hash, JSON metadata, and pgvector parameter', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const result = await store.upsertObservation(observation);

    expect(result).toEqual({ id: 42, createdAtEpoch: 1_700_000_000_000 });
    const insert = client.queries[0]!;
    expect(insert.text).toContain('INSERT INTO claude_mem_external_memory_items');
    expect(insert.text).toContain('$19::vector');
    expect(insert.text).toContain('ON CONFLICT (memory_session_id, kind, content_hash) DO UPDATE');
    expect(insert.values).toContain('observation');
    expect(insert.values).toContain('memory-session-1');
    expect(insert.values).toContain('claude-mem');
    expect(insert.values).toContain('[0.1,0.2,0.3]');
    expect(insert.values?.some(value => typeof value === 'string' && value.includes('SQLite remains default'))).toBe(true);
  });

  test('searches by pgvector cosine distance', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const rows = await store.searchByVector({ project: 'claude-mem', embedding: [0.1, 0.2], limit: 5 });

    expect(rows).toHaveLength(1);
    const query = client.queries[0]!;
    expect(query.text).toContain('embedding <=> $2::vector');
    expect(query.text).toContain('ORDER BY embedding <=> $2::vector ASC');
    expect(query.values).toEqual(['claude-mem', '[0.1,0.2]', 5]);
  });

  test('searches by Postgres full text when no query embedding is available', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const rows = await store.searchByText({ project: 'claude-mem', query: 'external storage', limit: 10 });

    expect(rows).toHaveLength(1);
    const query = client.queries[0]!;
    expect(query.text).toContain("content_search @@ websearch_to_tsquery('english', $2)");
    expect(query.values).toEqual(['claude-mem', 'external storage', 10]);
  });
});
