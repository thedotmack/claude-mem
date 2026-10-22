import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
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
  embedSearchQuery,
  getSharedEmbedder,
  getVectorSearchStatus,
} from '../../../src/server/services/ObservationEmbeddingService.js';
import type { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import type { Embedder } from '../../../src/services/vector/types.js';
import { createIsolatedSchema, dropSchema } from '../../sdk/pg-isolation.js';

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

  it('falls back to title and subtitle, ignoring the Untitled placeholder', () => {
    expect(observationEmbeddingParts('change', { title: 'A title', subtitle: 'sub' }, 'c'))
      .toEqual([{ part: 'title', text: 'A title\nsub' }]);
    expect(observationEmbeddingParts('change', { title: 'Untitled', subtitle: 'sub' }, 'c'))
      .toEqual([{ part: 'title', text: 'sub' }]);
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

  it('embeds the content of a row with no structured fields', () => {
    expect(observationEmbeddingParts('manual', {}, 'free text'))
      .toEqual([{ part: 'content', text: 'free text' }]);
  });
});

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

/** A unit vector along one axis, so nearness is exact and needs no model. */
function axis(index: number): Float32Array {
  const vector = new Float32Array(384);
  vector[index] = 1;
  return vector;
}

describe.skipIf(!testDatabaseUrl)('hybrid observation search', () => {
  let vectorAvailable = false;
  let schemaName: string;
  let pool: pg.Pool;
  let projectId: string;
  let teamId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = 'true';
    // The extension lives in public, so each test schema reaches it through
    // its search_path, the way a deployment with the default path does.
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    try {
      const available = await admin.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
      if (available.rows.length > 0) {
        await admin.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
        vectorAvailable = true;
      }
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    if (!vectorAvailable) return;
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
    if (!vectorAvailable) return;
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
  });

  afterAll(() => {
    delete process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH;
    if (!vectorAvailable) console.warn('pgvector not installed in the test database; hybrid search tests did nothing');
  });

  it('finds an observation by meaning when no keyword matches', async () => {
    if (!vectorAvailable) return;
    const repo = new PostgresObservationRepository(pool);
    const query = 'which machine compiles our meaning-based lookup';
    expect(await repo.search({ projectId, teamId, query })).toEqual([]);

    const results = await repo.search({ projectId, teamId, query, queryEmbedding: axis(1) });
    expect(results[0]?.id).toBe(ids.indexer);
  });

  it('ranks an observation found by both keyword and vector above one found by either', async () => {
    if (!vectorAvailable) return;
    const repo = new PostgresObservationRepository(pool);
    // "gateway" matches by keyword only; the vector points at the same row,
    // while "backup" is the second-nearest vector and matches no keyword.
    const nearGatewayThenBackup = axis(2);
    nearGatewayThenBackup[3] = 0.5;
    const results = await repo.search({ projectId, teamId, query: 'gateway', queryEmbedding: nearGatewayThenBackup });
    expect(results[0]?.id).toBe(ids.gateway);
    expect(results.map(o => o.id)).toContain(ids.backup);
  });

  it('finds a project\'s match by meaning when other projects hold nearer vectors', async () => {
    if (!vectorAvailable) return;
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
    expect((await repo.search({ projectId, teamId, query, queryEmbedding: nearer }))[0]?.id).toBe(ids.indexer);

    // A store this small is read through the scope index; a large one is read
    // through HNSW, where only an iterative scan gets past the other project's
    // nearer parts. Take that path here.
    await pool.query('DROP INDEX idx_observation_embeddings_scope');
    const hnswOnly = new pg.Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName},public -c enable_seqscan=off`,
    });
    try {
      const results = await new PostgresObservationRepository(hnswOnly).search({ projectId, teamId, query, queryEmbedding: nearer });
      expect(results[0]?.id).toBe(ids.indexer);
    } finally {
      await hnswOnly.end();
    }
  });

  it('finds a folder\'s match by meaning when other folders of the project hold nearer vectors', async () => {
    if (!vectorAvailable) return;
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
      .search({ projectId, teamId, query, queryEmbedding: nearer, folderProjects: ['here'] });
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

  it('counts rows without vectors from the current model as missing', async () => {
    if (!vectorAvailable) return;
    const embedder = (modelId: string): Embedder => ({ modelId, dims: 384, embed: async texts => texts.map(() => axis(1)) });
    const current = await getVectorSearchStatus(pool, embedder('test'));
    expect(current).toMatchObject({ available: true, model: 'test', observationsWithoutVectors: 0 });

    // A model change leaves every row's vectors in the old model's space.
    expect((await getVectorSearchStatus(pool, embedder('next'))).observationsWithoutVectors).toBe(3);
    const missing = await new PostgresObservationEmbeddingsRepository(pool).listMissing({ model: 'next', limit: 10 });
    expect(missing.map(row => row.id).sort()).toEqual(Object.values(ids).sort());
  });

  it('reports the last embedding failure until an embed succeeds', async () => {
    if (!vectorAvailable) return;
    const failing: Embedder = { modelId: 'test', dims: 384, embed: async () => { throw new Error('model download failed'); } };
    const working: Embedder = { modelId: 'test', dims: 384, embed: async texts => texts.map(() => axis(1)) };

    expect(await embedSearchQuery(pool, 'a query', failing)).toBeNull();
    expect((await getVectorSearchStatus(pool, failing)).lastEmbedError?.message).toBe('model download failed');

    expect(await embedSearchQuery(pool, 'a query', working)).not.toBeNull();
    expect((await getVectorSearchStatus(pool, working)).lastEmbedError).toBeNull();
  });

  it('skips a row the model cannot embed and backfills the rest', async () => {
    if (!vectorAvailable) return;
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

  it('embeds nothing while CLAUDE_MEM_SERVER_VECTOR_SEARCH is off', async () => {
    if (!vectorAvailable) return;
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
    if (!vectorAvailable) return;
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
    if (!vectorAvailable) return;
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

  it('boots keyword-only when the role cannot create pgvector', async () => {
    if (!vectorAvailable) return;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    const superuser = (await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0]?.rolsuper;
    if (!superuser) return void (await admin.end());
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

  it('deletes an observation\'s vectors with it', async () => {
    if (!vectorAvailable) return;
    await pool.query('DELETE FROM observations WHERE id = $1', [ids.indexer]);
    const remaining = await pool.query('SELECT count(*)::int AS n FROM observation_embeddings WHERE observation_id = $1', [ids.indexer]);
    expect(remaining.rows[0].n).toBe(0);
  });
});
