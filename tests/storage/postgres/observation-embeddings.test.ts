import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { availableParallelism } from 'os';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  PostgresObservationRepository,
} from '../../../src/storage/postgres/index.js';
import {
  observationEmbeddingParts,
  PostgresObservationEmbeddingsRepository,
} from '../../../src/storage/postgres/observation-embeddings.js';
import {
  backfillMissingEmbeddings,
  capEmbedderThreadsForBackfill,
  embedObservationRows,
  embedSearchQuery,
  getSharedEmbedder,
  getVectorSearchStatus,
} from '../../../src/server/services/ObservationEmbeddingService.js';
import type { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import type { Embedder } from '../../../src/services/vector/types.js';
import { createIsolatedSchema, dropSchema, pgvectorAvailable } from '../../sdk/pg-isolation.js';

describe('observationEmbeddingParts', () => {
  it('splits an observation into narrative, legacy text and each fact, named like the Chroma ids', () => {
    const parts = observationEmbeddingParts('discovery', {
      title: 'T',
      narrative: 'the narrative',
      facts: ['fact a', '', 'fact c'],
      legacy: { text: 'legacy text' },
    }, 'content');
    expect(parts).toEqual([
      { part: 'narrative', text: 'the narrative' },
      { part: 'text', text: 'legacy text' },
      { part: 'fact_0', text: 'fact a' },
      { part: 'fact_1', text: 'fact c' },
    ]);
  });

  it('falls back to title and subtitle, ignoring the Untitled placeholder, and adds the content', () => {
    expect(observationEmbeddingParts('change', { title: 'A title', subtitle: 'sub' }, 'A title\nsub'))
      .toEqual([{ part: 'title', text: 'A title\nsub' }]);
    expect(observationEmbeddingParts('change', { title: 'Untitled', subtitle: 'sub' }, ''))
      .toEqual([{ part: 'title', text: 'sub' }]);
    expect(observationEmbeddingParts('manual', { title: 'Operations' }, 'Backups run nightly to object storage.'))
      .toEqual([
        { part: 'title', text: 'Operations' },
        { part: 'content', text: 'Backups run nightly to object storage.' },
      ]);
  });

  it('embeds one part per summary field', () => {
    expect(observationEmbeddingParts('summary', {
      request: 'r', investigated: null, learned: 'l', next_steps: 'n',
    }, 'content')).toEqual([
      { part: 'request', text: 'r' },
      { part: 'learned', text: 'l' },
      { part: 'next_steps', text: 'n' },
    ]);
  });

  it('embeds at most 64 facts', () => {
    const facts = Array.from({ length: 100 }, (_, i) => `fact ${i}`);
    const parts = observationEmbeddingParts('discovery', { facts }, 'content');
    expect(parts).toHaveLength(64);
    expect(parts.at(-1)).toEqual({ part: 'fact_63', text: 'fact 63' });
  });

  it('embeds the content of a row with no structured fields', () => {
    expect(observationEmbeddingParts('manual', {}, 'free text'))
      .toEqual([{ part: 'content', text: 'free text' }]);
  });
});

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const vectorAvailable = await pgvectorAvailable(testDatabaseUrl);
const superuser = vectorAvailable && await (async () => {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    return (await client.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0]?.rolsuper === true;
  } finally {
    await client.end();
  }
})();

/** A unit vector along one axis, so nearness is exact and needs no model. */
function axis(index: number): Float32Array {
  const vector = new Float32Array(384);
  vector[index] = 1;
  return vector;
}

describe.skipIf(!vectorAvailable)('hybrid observation search', () => {
  let schemaName: string;
  let pool: pg.Pool;
  let projectId: string;
  let teamId: string;
  const ids: Record<string, string> = {};

  // The extension lives in public, so each test schema reaches it through
  // its search_path, the way a deployment with the default path does.
  beforeAll(() => {
    process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = 'true';
  });

  beforeEach(async () => {
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_vec_test');
    pool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName},public` });
    await bootstrapServerPostgresSchema(pool);
    const storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'project' });
    teamId = team.id;
    projectId = project.id;

    const embeddings = new PostgresObservationEmbeddingsRepository(pool);
    const rows: Array<[string, string, number]> = [
      ['indexer', 'The code-search indexer runs nightly on the build host.', 1],
      ['gateway', 'The gateway Worker moved to a custom domain.', 2],
      ['backup', 'Postgres is dumped before every schema change.', 3],
    ];
    for (const [key, content, axisIndex] of rows) {
      const observation = await storage.observations.create({ projectId, teamId, content, metadata: { narrative: content } });
      ids[key] = observation.id;
      await embeddings.upsert({
        observationId: observation.id,
        model: 'test',
        parts: [{ part: 'narrative', text: content }],
        vectors: [axis(axisIndex)],
      });
    }
  });

  afterEach(async () => {
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
  });

  afterAll(() => {
    delete process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH;
  });

  it('finds an observation by meaning when no keyword matches', async () => {
    const repo = new PostgresObservationRepository(pool);
    const query = 'which machine compiles our meaning-based lookup';
    expect(await repo.search({ projectId, teamId, query })).toEqual([]);

    const results = await repo.search({ projectId, teamId, query, queryEmbedding: { vector: axis(1), model: 'test' } });
    expect(results[0]?.id).toBe(ids.indexer);
  });

  it('compares the query only with parts embedded by its own model', async () => {
    if (!vectorAvailable) return;
    const storage = createPostgresStorageRepositories(pool);
    const content = 'Written before the model changed.';
    const stale = await storage.observations.create({ projectId, teamId, content, metadata: { narrative: content } });
    await new PostgresObservationEmbeddingsRepository(pool).upsert({
      observationId: stale.id,
      model: 'previous',
      parts: [{ part: 'narrative', text: content }],
      vectors: [axis(1)],
    });
    const repo = new PostgresObservationRepository(pool);
    const query = 'which machine compiles our meaning-based lookup';

    const current = (await repo.search({ projectId, teamId, query, queryEmbedding: { vector: axis(1), model: 'test' } })).map(o => o.id);
    expect(current[0]).toBe(ids.indexer);
    expect(current).not.toContain(stale.id);

    const previous = (await repo.search({ projectId, teamId, query, queryEmbedding: { vector: axis(1), model: 'previous' } })).map(o => o.id);
    expect(previous).toEqual([stale.id]);
  });

  it('ranks an observation found by both keyword and vector above one found by either', async () => {
    const repo = new PostgresObservationRepository(pool);
    // "gateway" matches by keyword only; the vector points at the same row,
    // while "backup" is the second-nearest vector and matches no keyword.
    const nearGatewayThenBackup = axis(2);
    nearGatewayThenBackup[3] = 0.5;
    const results = await repo.search({ projectId, teamId, query: 'gateway', queryEmbedding: { vector: nearGatewayThenBackup, model: 'test' } });
    expect(results[0]?.id).toBe(ids.gateway);
    expect(results.map(o => o.id)).toContain(ids.backup);
  });

  it('finds a project\'s match by meaning when other projects hold nearer vectors', async () => {
    const storage = createPostgresStorageRepositories(pool);
    const other = await storage.projects.create({ teamId, name: 'other' });
    // More parts than the nearest-parts limit, each nearer the query than
    // this project's indexer row: an unfiltered scan sees only these. Distinct
    // vectors, since identical ones leave an HNSW graph with nothing to follow.
    const nearer = axis(1);
    nearer[10] = 0.1;
    await pool.query(
      `INSERT INTO observations (id, project_id, team_id, content)
       SELECT 'other-' || g, $1, $2, 'unrelated row ' || g FROM generate_series(1, 450) AS g`,
      [other.id, teamId],
    );
    await pool.query(
      `INSERT INTO observation_embeddings (observation_id, project_id, team_id, part, model, embedding)
       SELECT 'other-' || g, $1, $2, 'narrative', 'test',
         ('[' || array_to_string(array_fill(0, ARRAY[1]) || 1 || array_fill(0, ARRAY[8])
           || (0.05 + g * 0.0001) || array_fill(0, ARRAY[373]), ',') || ']')::vector
       FROM generate_series(1, 450) AS g`,
      [other.id, teamId],
    );

    const query = 'which machine compiles our meaning-based lookup';
    const repo = new PostgresObservationRepository(pool);
    expect((await repo.search({ projectId, teamId, query, queryEmbedding: { vector: nearer, model: 'test' } }))[0]?.id).toBe(ids.indexer);

    // A store this small is read through the scope index; a large one is read
    // through HNSW, where only an iterative scan gets past the other project's
    // nearer parts. Take that path here.
    await pool.query('DROP INDEX idx_observation_embeddings_scope');
    const hnswOnly = new pg.Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName},public -c enable_seqscan=off`,
    });
    try {
      const results = await new PostgresObservationRepository(hnswOnly).search({ projectId, teamId, query, queryEmbedding: { vector: nearer, model: 'test' } });
      expect(results[0]?.id).toBe(ids.indexer);
    } finally {
      await hnswOnly.end();
    }
  });

  it('finds a folder\'s match by meaning when other folders of the project hold nearer vectors', async () => {
    await pool.query(`UPDATE observations SET metadata = metadata || '{"project": "here"}' WHERE id = $1`, [ids.indexer]);
    const nearer = axis(1);
    nearer[10] = 0.1;
    // More parts than the nearest-parts limit, all nearer the query and all in
    // another folder of the same project, which the search filters out.
    await pool.query(
      `INSERT INTO observations (id, project_id, team_id, content, metadata)
       SELECT 'elsewhere-' || g, $1, $2, 'unrelated row ' || g, '{"project": "elsewhere"}'
       FROM generate_series(1, 450) AS g`,
      [projectId, teamId],
    );
    await pool.query(
      `INSERT INTO observation_embeddings (observation_id, project_id, team_id, part, model, embedding)
       SELECT 'elsewhere-' || g, $1, $2, 'narrative', 'test',
         ('[' || array_to_string(array_fill(0, ARRAY[1]) || 1 || array_fill(0, ARRAY[8])
           || (0.05 + g * 0.0001) || array_fill(0, ARRAY[373]), ',') || ']')::vector
       FROM generate_series(1, 450) AS g`,
      [projectId, teamId],
    );
    const query = 'which machine compiles our meaning-based lookup';
    const search = (p: pg.Pool) => new PostgresObservationRepository(p)
      .search({ projectId, teamId, query, queryEmbedding: { vector: nearer, model: 'test' }, folderProjects: ['here'] });
    expect((await search(pool)).map(o => o.id)).toEqual([ids.indexer]);

    // Through HNSW too, where the folder filter has to hold before the cutoff.
    const hnswOnly = new pg.Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName},public -c enable_seqscan=off`,
    });
    try {
      expect((await search(hnswOnly)).map(o => o.id)).toEqual([ids.indexer]);
    } finally {
      await hnswOnly.end();
    }
  });

  it('fills a limit above the per-leg candidate count', async () => {
    await pool.query(
      `INSERT INTO observations (id, project_id, team_id, content)
       SELECT 'match-' || g, $1, $2, 'gateway note ' || g FROM generate_series(1, 150) AS g`,
      [projectId, teamId],
    );
    const results = await new PostgresObservationRepository(pool)
      .search({ projectId, teamId, query: 'gateway', limit: 150, queryEmbedding: { vector: axis(1), model: 'test' } });
    expect(results.length).toBe(150);
  });

  it('finds an observation by meaning when fact-heavy observations fill the nearest-parts cutoff', async () => {
    // Seven observations of 64 facts each: 448 parts, all nearer the query
    // than "backup", more than the 400 nearest parts read at first.
    await pool.query(
      `INSERT INTO observations (id, project_id, team_id, content)
       SELECT 'heavy-' || g, $1, $2, 'unrelated row ' || g FROM generate_series(1, 7) AS g`,
      [projectId, teamId],
    );
    await pool.query(
      `INSERT INTO observation_embeddings (observation_id, project_id, team_id, part, model, embedding)
       SELECT 'heavy-' || g, $1, $2, 'fact_' || f, 'test',
         ('[' || array_to_string(array_fill(0, ARRAY[5]) || 1 || array_fill(0, ARRAY[94])
           || (0.0001 * (g * 64 + f)) || array_fill(0, ARRAY[283]), ',') || ']')::vector
       FROM generate_series(1, 7) AS g, generate_series(0, 63) AS f`,
      [projectId, teamId],
    );
    const query = axis(5);
    query[3] = 0.5;
    const results = await new PostgresObservationRepository(pool)
      .search({ projectId, teamId, query: 'zzqx nothing matches this', queryEmbedding: { vector: query, model: 'test' } });
    const found = results.map(row => row.id);
    expect(found.filter(id => id.startsWith('heavy-')).length).toBe(7);
    expect(found).toContain(ids.backup);
  });

  it('searches with a limit whose nearest-part count exceeds pgvector\'s ef_search maximum', async () => {
    // 4 x 300 nearest parts would ask for ef_search 1200; pgvector allows 1000.
    const results = await new PostgresObservationRepository(pool)
      .search({ projectId, teamId, query: 'gateway', limit: 300, queryEmbedding: { vector: axis(1), model: 'test' } });
    expect(results.map(row => row.id)).toContain(ids.gateway);
  });

  it('counts rows without vectors from the current model as missing', async () => {
    const embedder = (modelId: string): Embedder => ({ modelId, dims: 384, embed: async texts => texts.map(() => axis(1)) });
    const current = await getVectorSearchStatus(pool, embedder('test'));
    expect(current).toMatchObject({ available: true, model: 'test', observationsWithoutVectors: 0 });

    // A model change leaves every row's vectors in the old model's space.
    expect((await getVectorSearchStatus(pool, embedder('next'))).observationsWithoutVectors).toBe(3);
    const missing = await new PostgresObservationEmbeddingsRepository(pool).listMissing({ model: 'next', limit: 10 });
    expect(missing.map(row => row.id).sort()).toEqual(Object.values(ids).sort());
  });

  it('counts missing vectors once a minute, not on every status read', async () => {
    const embedder: Embedder = { modelId: 'test', dims: 384, embed: async texts => texts.map(() => axis(1)) };
    const count = spyOn(PostgresObservationEmbeddingsRepository.prototype, 'countMissing');
    try {
      await getVectorSearchStatus(pool, embedder);
      await getVectorSearchStatus(pool, embedder);
      expect(count).toHaveBeenCalledTimes(1);
    } finally {
      count.mockRestore();
    }
  });

  it('reports the last embedding failure until an embed succeeds', async () => {
    const failing: Embedder = { modelId: 'test', dims: 384, embed: async () => { throw new Error('model download failed'); } };
    const working: Embedder = { modelId: 'test', dims: 384, embed: async texts => texts.map(() => axis(1)) };

    expect(await embedSearchQuery(pool, 'a query', failing)).toBeNull();
    expect((await getVectorSearchStatus(pool, failing)).lastEmbedError?.message).toBe('model download failed');

    expect(await embedSearchQuery(pool, 'a query', working)).not.toBeNull();
    expect((await getVectorSearchStatus(pool, working)).lastEmbedError).toBeNull();
  });

  it('skips a row the model cannot embed and backfills the rest', async () => {
    const embedder: Embedder = {
      modelId: 'next',
      dims: 384,
      embed: async texts => {
        if (texts.some(text => text.includes('gateway'))) throw new Error('cannot embed');
        return texts.map(() => axis(1));
      },
    };
    expect(await backfillMissingEmbeddings(pool, { embedder })).toEqual({ observations: 2, parts: 2 });
    const missing = await new PostgresObservationEmbeddingsRepository(pool).listMissing({ model: 'next', limit: 10 });
    expect(missing.map(row => row.id)).toEqual([ids.gateway]);

    // A failure every row shares stops the backfill instead of paging through all of them.
    const failing: Embedder = { modelId: 'other', dims: 384, embed: async () => { throw new Error('model download failed'); } };
    expect(await backfillMissingEmbeddings(pool, { embedder: failing, batchSize: 1 })).toEqual({ observations: 0, parts: 0 });
  });

  it('finishes when the last row yields no parts', async () => {
    // The newest row, stored with microseconds, has nothing to embed, so it
    // stays missing; paging past it must not land back on it.
    await pool.query(
      `INSERT INTO observations (id, project_id, team_id, content, created_at)
       VALUES ('blank', $1, $2, '   ', now() + interval '1.234567 second')`,
      [projectId, teamId],
    );
    const embedder: Embedder = { modelId: 'next', dims: 384, embed: async texts => texts.map(() => axis(1)) };
    expect(await backfillMissingEmbeddings(pool, { embedder, batchSize: 2 })).toEqual({ observations: 4, parts: 3 });
  }, 10_000);

  it('lets one of two concurrent backfills do the work', async () => {
    let embedCalls = 0;
    const embedder: Embedder = {
      modelId: 'next',
      dims: 384,
      embed: async texts => {
        embedCalls++;
        await new Promise(resolve => setTimeout(resolve, 200));
        return texts.map(() => axis(1));
      },
    };
    const [a, b] = await Promise.all([
      backfillMissingEmbeddings(pool, { embedder }),
      backfillMissingEmbeddings(pool, { embedder }),
    ]);
    expect([a.observations, b.observations].sort()).toEqual([0, 3]);
    expect(embedCalls).toBe(1);
  });

  it('backfills through a pool of one connection', async () => {
    const single = new pg.Pool({ connectionString: testDatabaseUrl, max: 1, options: `-c search_path=${schemaName},public` });
    try {
      const embedder: Embedder = { modelId: 'next', dims: 384, embed: async texts => texts.map(() => axis(1)) };
      expect(await backfillMissingEmbeddings(single, { embedder })).toEqual({ observations: 3, parts: 3 });
    } finally {
      await single.end();
    }
  }, 10_000);

  it('stops between batches when signalled, releasing its lock for the next start', async () => {
    const stop = new AbortController();
    const stopping: Embedder = {
      modelId: 'next',
      dims: 384,
      embed: async texts => {
        stop.abort(); // the server is stopping while the first batch embeds
        return texts.map(() => axis(1));
      },
    };
    expect(await backfillMissingEmbeddings(pool, { embedder: stopping, batchSize: 1, signal: stop.signal }))
      .toEqual({ observations: 0, parts: 0 });
    const resumed: Embedder = { modelId: 'next', dims: 384, embed: async texts => texts.map(() => axis(1)) };
    expect(await backfillMissingEmbeddings(pool, { embedder: resumed })).toEqual({ observations: 3, parts: 3 });
  });

  it('leaves the pool\'s connections to requests while it backfills', async () => {
    // A pool of one: the advisory lock must not hold its only connection.
    const single = new pg.Pool({ connectionString: testDatabaseUrl, max: 1, options: `-c search_path=${schemaName},public` });
    try {
      let requestServed = false;
      const embedder: Embedder = {
        modelId: 'next',
        dims: 384,
        embed: async texts => {
          // A request arriving mid-backfill gets a connection at once.
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request starved')), 2_000));
          await Promise.race([single.query('SELECT 1'), timeout]);
          requestServed = true;
          return texts.map(() => axis(1));
        },
      };
      expect(await backfillMissingEmbeddings(single, { embedder })).toEqual({ observations: 3, parts: 3 });
      expect(requestServed).toBe(true);
    } finally {
      await single.end();
    }
  }, 10_000);

  it('does not wait for a model that is still loading on a search or a save', async () => {
    let embedCalls = 0;
    const loading: Embedder = {
      modelId: 'next',
      dims: 384,
      isReady: () => false,
      warm: () => new Promise<boolean>(() => {}), // a download that never finishes
      embed: async texts => {
        embedCalls++;
        return texts.map(() => axis(1));
      },
    };
    const started = Date.now();
    expect(await embedSearchQuery(pool, 'a query', loading, { waitForModelMs: 50 })).toBeNull();
    expect(await embedObservationRows(pool, [{ kind: 'observation', metadata: {}, content: 'x' }], loading, { waitForModelMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(embedCalls).toBe(0);
  });

  it('backfills once the model has loaded, and gives up waiting when stopped', async () => {
    let finishLoad!: (ready: boolean) => void;
    const load = new Promise<boolean>(resolve => { finishLoad = resolve; });
    let ready = false;
    const embedder: Embedder = {
      modelId: 'next',
      dims: 384,
      isReady: () => ready,
      warm: () => load,
      embed: async texts => texts.map(() => axis(1)),
    };
    const stop = new AbortController();
    const stopped = backfillMissingEmbeddings(pool, { embedder, signal: stop.signal });
    stop.abort();
    expect(await stopped).toEqual({ observations: 0, parts: 0 });

    const backfill = backfillMissingEmbeddings(pool, { embedder });
    ready = true;
    finishLoad(true);
    expect(await backfill).toEqual({ observations: 3, parts: 3 });
  });

  it('embeds nothing while CLAUDE_MEM_SERVER_VECTOR_SEARCH is off', async () => {
    const working: Embedder = { modelId: 'test', dims: 384, embed: async texts => texts.map(() => axis(1)) };
    process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = 'false';
    try {
      expect(await embedSearchQuery(pool, 'a query', working)).toBeNull();
      expect((await getVectorSearchStatus(pool, working)).available).toBe(false);
    } finally {
      process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = 'true';
    }
  });

  it('caps the shared embedder\'s threads only while stored rows need vectors', async () => {
    // The rows above carry 'test' vectors, so the configured model has a backlog.
    process.env.CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS = '3';
    try {
      expect(await capEmbedderThreadsForBackfill(pool)).toBe(3);
      expect((getSharedEmbedder() as LocalEmbedder).threads).toBe(3);

      process.env.CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS = '0';
      expect(await capEmbedderThreadsForBackfill(pool)).toBeNull();

      // An unreadable value takes the default, half the threads, not all.
      process.env.CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS = 'four';
      expect(await capEmbedderThreadsForBackfill(pool)).toBe(Math.max(1, Math.floor(availableParallelism() / 2)));

      process.env.CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS = '3';
      const embeddings = new PostgresObservationEmbeddingsRepository(pool);
      for (const id of Object.values(ids)) {
        await embeddings.upsert({ observationId: id, model: getSharedEmbedder().modelId, parts: [{ part: 'narrative', text: 'x' }], vectors: [axis(1)] });
      }
      expect(await capEmbedderThreadsForBackfill(pool)).toBeNull();
    } finally {
      delete process.env.CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS;
    }
  });

  it('creates the vector table on a new database only, unless told to', async () => {
    const hasTable = async (client: pg.Pool, schema: string) =>
      (await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`${schema}.observation_embeddings`])).rows[0].present;
    const fresh = await createIsolatedSchema(testDatabaseUrl!, 'cm_vec_auto');
    const freshPool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${fresh},public` });
    const existing = await createIsolatedSchema(testDatabaseUrl!, 'cm_vec_old');
    const existingPool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${existing},public` });
    try {
      await bootstrapServerPostgresSchema(freshPool, 'auto');
      expect(await hasTable(freshPool, fresh)).toBe(true);

      // A deployment bootstrapped before search by meaning.
      await bootstrapServerPostgresSchema(existingPool, 'off');
      expect(await hasTable(existingPool, existing)).toBe(false);
      await bootstrapServerPostgresSchema(existingPool, 'auto');
      expect(await hasTable(existingPool, existing)).toBe(false);
      await bootstrapServerPostgresSchema(existingPool, 'on');
      expect(await hasTable(existingPool, existing)).toBe(true);
      await bootstrapServerPostgresSchema(existingPool, 'auto');
      expect(await hasTable(existingPool, existing)).toBe(true);
    } finally {
      await freshPool.end();
      await existingPool.end();
      await dropSchema(testDatabaseUrl!, fresh);
      await dropSchema(testDatabaseUrl!, existing);
    }
  });

  it('stays keyword-only when pgvector is outside the search_path', async () => {
    // Installed in public, which this schema's search_path leaves out, so the
    // vector type cannot be named here.
    const hidden = await createIsolatedSchema(testDatabaseUrl!, 'cm_vec_hidden');
    const hiddenPool = new pg.Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${hidden}` });
    const working: Embedder = { modelId: 'test', dims: 384, embed: async texts => texts.map(() => axis(1)) };
    try {
      await bootstrapServerPostgresSchema(hiddenPool, 'on');
      const table = await hiddenPool.query(`SELECT to_regclass('observation_embeddings') IS NOT NULL AS present`);
      expect(table.rows[0].present).toBe(false);
      expect(await embedSearchQuery(hiddenPool, 'a query', working)).toBeNull();
      expect(await backfillMissingEmbeddings(hiddenPool, { embedder: working })).toEqual({ observations: 0, parts: 0 });
      expect((await getVectorSearchStatus(hiddenPool, working)).available).toBe(false);
    } finally {
      await hiddenPool.end();
      await dropSchema(testDatabaseUrl!, hidden);
    }
  });

  it.skipIf(!superuser)('boots keyword-only when the role cannot create pgvector', async () => {
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    const role = 'cm_vec_noext';
    const database = 'cm_vec_noext';
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x'`);
    await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
    const url = new URL(testDatabaseUrl!);
    url.username = role;
    url.password = 'x';
    url.pathname = `/${database}`;
    const ownerPool = new pg.Pool({ connectionString: url.toString() });
    try {
      await bootstrapServerPostgresSchema(ownerPool, 'on');
      const tables = await ownerPool.query(
        `SELECT to_regclass('observations') IS NOT NULL AS observations,
                to_regclass('observation_embeddings') IS NOT NULL AS embeddings`
      );
      expect(tables.rows[0]).toEqual({ observations: true, embeddings: false });
    } finally {
      await ownerPool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
    // DROP DATABASE forces a checkpoint, which takes seconds after a busy run.
  }, 30_000);

  it('keeps the vectors when the model\'s width is unchanged, and starts over when it changes', async () => {
    if (!vectorAvailable) return;
    const stored = async () => {
      const result = await pool.query(
        `SELECT (SELECT atttypmod FROM pg_attribute
                 WHERE attrelid = 'observation_embeddings'::regclass AND attname = 'embedding') AS dims,
                (SELECT count(*)::int FROM observation_embeddings) AS rows`
      );
      return result.rows[0];
    };
    await bootstrapServerPostgresSchema(pool, 'on', 384);
    expect(await stored()).toEqual({ dims: 384, rows: 3 });

    await bootstrapServerPostgresSchema(pool, 'on', 768);
    expect(await stored()).toEqual({ dims: 768, rows: 0 });
  });

  it('deletes an observation\'s vectors with it', async () => {
    await pool.query('DELETE FROM observations WHERE id = $1', [ids.indexer]);
    const remaining = await pool.query('SELECT count(*)::int AS n FROM observation_embeddings WHERE observation_id = $1', [ids.indexer]);
    expect(remaining.rows[0].n).toBe(0);
  });
});
