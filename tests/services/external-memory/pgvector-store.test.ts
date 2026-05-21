import { describe, expect, test } from 'bun:test';
import { PgvectorMemoryStore } from '../../../src/services/external-memory/pgvector-store.js';

class FakePgClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    if (text.includes('RETURNING id, created_at_epoch')) {
      return { rows: [{ id: 42, created_at_epoch: 1_700_000_000_000 }], rowCount: 1 };
    }
    if (text.includes('WITH before_items')) {
      return { rows: [
        {
          id: 41,
          memory_session_id: 'memory-session-1',
          project: 'claude-mem',
          kind: 'summary',
          type: 'session_summary',
          title: 'Use external store',
          subtitle: null,
          content: 'Session summary',
          facts: [],
          narrative: 'External memory is primary.',
          concepts: [],
          files_read: [],
          files_modified: [],
          prompt_number: 2,
          discovery_tokens: 50,
          metadata: { request: 'Use external store', learned: 'External memory is primary.' },
          created_at: null,
          created_at_epoch: 1_699_999_999_000,
        },
        {
          id: 42,
          memory_session_id: 'memory-session-1',
          project: 'claude-mem',
          kind: 'observation',
          type: 'decision',
          title: 'Use external store',
          subtitle: 'pgvector + valkey',
          content: 'Use external store\n\nExternal memory is primary.',
          facts: ['Postgres is primary'],
          narrative: 'External memory is primary.',
          concepts: ['storage', 'pgvector'],
          files_read: ['CLAUDE.md'],
          files_modified: [],
          prompt_number: 3,
          discovery_tokens: 123,
          metadata: { primary: true },
          created_at: null,
          created_at_epoch: 1_700_000_000_000,
        },
      ], rowCount: 2 };
    }
    if (text.includes("COUNT(*) FILTER (WHERE kind = 'observation')")) {
      return { rows: [{
        observations: '3',
        summaries: '2',
        first_observation_at: new Date('2026-01-02T03:04:05.000Z'),
      }], rowCount: 1 };
    }
    if (text.includes('SELECT DISTINCT project')) {
      return { rows: [{ project: 'base-infra' }, { project: 'claude-mem' }], rowCount: 2 };
    }
    if (text.includes('MAX(created_at_epoch) AS latest_epoch')) {
      return { rows: [{ project: 'claude-mem', latest_epoch: 2 }, { project: 'base-infra', latest_epoch: 1 }], rowCount: 2 };
    }
    if (text.includes('SELECT id, memory_session_id, project, kind')) {
      return { rows: [{
        id: 42,
        memory_session_id: 'memory-session-1',
        project: 'claude-mem',
        kind: 'observation',
        type: 'decision',
        title: 'Use external store',
        subtitle: 'pgvector + valkey',
        content: 'Use external store\n\nExternal memory is primary.',
        facts: ['Postgres is primary'],
        narrative: 'External memory is primary.',
        concepts: ['storage', 'pgvector'],
        files_read: ['CLAUDE.md'],
        files_modified: [],
        prompt_number: 3,
        discovery_tokens: 123,
        metadata: { primary: true },
        created_at: null,
        created_at_epoch: 1_700_000_000_000,
      }], rowCount: 1 };
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
    expect(insert.text).toContain('embedding = COALESCE(EXCLUDED.embedding, claude_mem_external_memory_items.embedding)');
    expect(insert.values).toContain('observation');
    expect(insert.values).toContain('memory-session-1');
    expect(insert.values).toContain('claude-mem');
    expect(insert.values).toContain('[0.1,0.2,0.3]');
    expect(insert.values?.some(value => typeof value === 'string' && value.includes('SQLite remains default'))).toBe(true);
  });


  test('supports primary writes without a source SQLite id', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    await store.upsertObservation({ ...observation, sqliteId: null });

    const insert = client.queries[0]!;
    expect(insert.values?.[14]).toBeNull();
  });

  test('hydrates observations by external ids for primary mode retrieval', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const rows = await store.getObservationsByIds([42], { orderBy: 'relevance', project: 'claude-mem' });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 42,
      memory_session_id: 'memory-session-1',
      project: 'claude-mem',
      title: 'Use external store',
      narrative: 'External memory is primary.',
    });
    expect(rows[0]?.facts).toBe(JSON.stringify(['Postgres is primary']));
    const query = client.queries[0]!;
    expect(query.text).toContain('id = ANY($1::bigint[])');
    expect(query.values?.[0]).toEqual([42]);
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

  test('searches primary observations with Postgres FTS and metadata filters', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const rows = await store.searchObservations('external storage', {
      project: 'claude-mem',
      type: 'decision',
      concepts: ['pgvector'],
      files: ['CLAUDE.md'],
      limit: 7,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Use external store');
    const query = client.queries[0]!;
    expect(query.text).toContain("content_search @@ websearch_to_tsquery('english'");
    expect(query.text).toContain('ts_rank(content_search');
    expect(query.text).toContain('type = ANY');
    expect(query.text).toContain('concepts ?|');
    expect(query.text).toContain('jsonb_array_elements_text(files_read)');
    expect(query.values).toContain('external storage');
    expect(query.values).toContain('claude-mem');
    expect(query.values).toContainEqual(['decision']);
    expect(query.values).toContainEqual(['pgvector']);
  });

  test('builds primary-mode timeline windows without SQLite', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const timeline = await store.getTimelineAroundObservation(42, 1_700_000_000_000, 2, 3, 'claude-mem');

    expect(timeline.observations).toHaveLength(1);
    expect(timeline.sessions).toHaveLength(1);
    expect(timeline.prompts).toEqual([]);
    const query = client.queries[0]!;
    expect(query.text).toContain('created_at_epoch < $1');
    expect(query.text).toContain('created_at_epoch >= $1');
    expect(query.text).toContain("kind IN ('observation', 'summary')");
    expect(query.values).toEqual([
      1_700_000_000_000,
      'claude-mem',
      2,
      4,
    ]);
  });

  test('reports external primary stats from Postgres counts', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const stats = await store.getStats();

    expect(stats).toEqual({
      observations: 3,
      summaries: 2,
      firstObservationAt: '2026-01-02T03:04:05.000Z',
    });
    expect(client.queries[0]?.text).toContain("COUNT(*) FILTER (WHERE kind = 'observation')");
  });

  test('reports project catalog from external primary projects', async () => {
    const client = new FakePgClient();
    const store = new PgvectorMemoryStore(client);

    const projects = await store.getAllProjects('claude');
    const skipped = await store.getAllProjects('codex');
    const catalog = await store.getProjectCatalog();

    expect(projects).toEqual(['base-infra', 'claude-mem']);
    expect(skipped).toEqual([]);
    expect(catalog).toEqual({
      projects: ['claude-mem', 'base-infra'],
      sources: ['claude'],
      projectsBySource: { claude: ['claude-mem', 'base-infra'] },
    });
  });
});
