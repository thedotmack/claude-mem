// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue, PostgresQueryable } from './utils.js';
import {
  assertProjectOwnership,
  assertSessionOwnership,
  canonicalJson,
  deterministicKey,
  newId,
  queryOne,
  toEpoch,
  toJsonObject
} from './utils.js';
import { normalizePlatformSourceOrNull } from '../../shared/platform-source.js';
import { bm25Order, usesBm25Index } from './schema.js';
import { MAX_FACT_PARTS, toVectorLiteral } from './observation-embeddings.js';
import { withPostgresTransaction, type PostgresPool } from './pool.js';

export type ObservationSourceType = 'agent_event' | 'session_summary' | 'observation_reindex' | 'manual';

export interface PostgresObservation {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  contentSessionId?: string | null;
  kind: string;
  content: string;
  generationKey: string | null;
  metadata: JsonObject;
  embedding: JsonValue | null;
  createdByJobId: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface PostgresObservationSource {
  id: string;
  observationId: string;
  agentEventId: string | null;
  generationJobId: string | null;
  sourceType: ObservationSourceType;
  sourceId: string;
  metadata: JsonObject;
  createdAtEpoch: number;
}

interface ObservationRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  content_session_id?: string | null;
  kind: string;
  content: string;
  generation_key: string | null;
  metadata: unknown;
  embedding: unknown | null;
  created_by_job_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ObservationSourceRow {
  id: string;
  observation_id: string;
  agent_event_id: string | null;
  generation_job_id: string | null;
  source_type: ObservationSourceType;
  source_id: string;
  metadata: unknown;
  created_at: Date;
}

// Any term of $3, as the english tsvector's lexemes ORed: whether a row holds
// any term of the query, as the bm25 index tokenizes it.
const ANY_TERM_TSQUERY_SQL = `(
  SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery
  FROM unnest(tsvector_to_array(to_tsvector('english', $3))) AS lexeme
)`;

// Every filter search() applies besides the text match: project, team,
// summary kind, folder labels, subagent exclusion and platform. Shared by the
// keyword and the hybrid query so both legs of a hybrid search see the same rows. Expects
// server_sessions joined as search() joins it, and parameters $1 project,
// $2 team, $5 platform, $6 folders, $7 excludeSubagents, $8 summary.
const SEARCH_SCOPE_SQL = `
  observations.project_id = $1
  AND observations.team_id = $2
  AND ($8::boolean IS NULL OR (observations.kind = 'summary') = $8)
  AND (
    $6::text[] IS NULL
    OR lower((observations.metadata->>'project') COLLATE "C") = ANY(
      SELECT lower(folder COLLATE "C") FROM unnest($6::text[]) AS folder
    )
  )
  AND (
    NOT $7::boolean
    OR NOT EXISTS (
      SELECT 1
      FROM observation_sources
      INNER JOIN agent_events
        ON agent_events.id = observation_sources.agent_event_id
        AND agent_events.project_id = observations.project_id
        AND agent_events.team_id = observations.team_id
      WHERE observation_sources.observation_id = observations.id
        AND observation_sources.source_type = 'agent_event'
        AND COALESCE(agent_events.payload->>'agentId', '') <> ''
        AND COALESCE(agent_events.payload->>'agentType', '') <> ''
    )
  )
  AND (
    $5::text IS NULL
    OR server_sessions.platform_source = $5
    OR (
      observations.server_session_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM observation_sources
        INNER JOIN agent_events
          ON agent_events.id = observation_sources.agent_event_id
          AND agent_events.project_id = observations.project_id
          AND agent_events.team_id = observations.team_id
        WHERE observation_sources.observation_id = observations.id
          AND observation_sources.source_type = 'agent_event'
          AND agent_events.platform_source = $5
      )
    )
  )
`;

// Reciprocal rank fusion constant: the conventional 60 (Cormack et al. 2009).
const RRF_K = 60;
// Ranked candidates per leg of a hybrid search, at least; a larger limit
// takes as many, so fusion can fill it.
const HYBRID_LEG_CANDIDATES = 100;
// Nearest parts read from the HNSW index; several parts can belong to one
// observation, so this is a multiple of HYBRID_LEG_CANDIDATES.
const HYBRID_NEAREST_PARTS = 400;
// The most parts one observation can have: a narrative, a legacy text and
// MAX_FACT_PARTS facts (observationEmbeddingParts); a summary has fewer.
const MAX_PARTS_PER_OBSERVATION = MAX_FACT_PARTS + 2;

type HybridSearchRow = ObservationRow & { nearest_parts_read: number; semantic_candidates: number };

function isPool(client: PostgresQueryable): client is PostgresPool {
  const candidate = client as { connect?: unknown; release?: unknown };
  return typeof candidate.connect === 'function' && typeof candidate.release !== 'function';
}

/**
 * Whether a keyword query uses websearch_to_tsquery syntax: a double quote
 * (phrase), a word starting with "-" (exclusion), or a standalone "or".
 */
export function usesWebsearchSyntax(query: string): boolean {
  return /"|(^|\s)-\S|(^|\s)or(\s|$)/i.test(query);
}

export class PostgresObservationRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    kind?: string;
    content: string;
    generationKey?: string | null;
    metadata?: JsonObject;
    embedding?: JsonValue | null;
    createdByJobId?: string | null;
  }): Promise<PostgresObservation> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    if (input.serverSessionId) {
      await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
    }
    if (input.createdByJobId) {
      await assertJobOwnership(this.client, input.createdByJobId, input.projectId, input.teamId);
    }

    const row = await queryOne<ObservationRow>(
      this.client,
      `
        INSERT INTO observations (
          id, project_id, team_id, server_session_id, kind, content,
          generation_key, metadata, embedding, created_by_job_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
        ON CONFLICT (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL DO UPDATE SET
          updated_at = observations.updated_at
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.projectId,
        input.teamId,
        input.serverSessionId ?? null,
        input.kind ?? 'observation',
        input.content,
        input.generationKey ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.embedding == null ? null : JSON.stringify(input.embedding),
        input.createdByJobId ?? null
      ]
    );
    return mapObservationRow(row!);
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservation | null> {
    const row = await queryOne<ObservationRow>(
      this.client,
      'SELECT * FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapObservationRow(row) : null;
  }

  async getManyForScope(input: {
    ids: string[];
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservation[]> {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) return [];
    const result = await this.client.query<ObservationRow>(
      `SELECT * FROM observations
       WHERE id = ANY($1::text[]) AND project_id = $2 AND team_id = $3
       ORDER BY array_position($1::text[], id)`,
      [ids, input.projectId, input.teamId],
    );
    return result.rows.map(mapObservationRow);
  }

  /** Resolve the anchor inside the caller's scope before reading its neighbors. */
  async timelineAround(input: {
    anchorId: string;
    projectId: string;
    teamId: string;
    depthBefore?: number;
    depthAfter?: number;
  }): Promise<PostgresObservation[]> {
    const depthBefore = input.depthBefore ?? 3;
    const depthAfter = input.depthAfter ?? 3;
    for (const depth of [depthBefore, depthAfter]) {
      if (!Number.isInteger(depth) || depth < 0 || depth > 20) throw new Error('Timeline depth must be an integer from 0 to 20');
    }
    const result = await this.client.query<ObservationRow>(
      `WITH anchor AS (
         SELECT * FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3
       ), preceding AS (
         SELECT o.* FROM observations o, anchor a
         WHERE o.project_id = $2 AND o.team_id = $3
           AND (o.created_at, o.id) < (a.created_at, a.id)
         ORDER BY o.created_at DESC, o.id DESC LIMIT $4
       ), following AS (
         SELECT o.* FROM observations o, anchor a
         WHERE o.project_id = $2 AND o.team_id = $3
           AND (o.created_at, o.id) > (a.created_at, a.id)
         ORDER BY o.created_at, o.id LIMIT $5
       )
       SELECT * FROM (
         SELECT * FROM preceding UNION ALL SELECT * FROM anchor UNION ALL SELECT * FROM following
       ) context ORDER BY created_at, id`,
      [input.anchorId, input.projectId, input.teamId, depthBefore, depthAfter],
    );
    return result.rows.map(mapObservationRow);
  }

  async listByProject(input: {
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    limit?: number;
  }): Promise<PostgresObservation[]> {
    const result = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND ($3::text IS NULL OR server_session_id = $3)
        ORDER BY created_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, input.serverSessionId ?? null, input.limit ?? 100]
    );
    return result.rows.map(mapObservationRow);
  }

  // `query` is optional. Without one the FTS predicate and ranking drop out and
  // rows come back newest first by creation time: the "what happened recently"
  // read a session-start block needs (/v1/context). Ordered by `created_at`,
  // not `updated_at`, so touching an old row does not move it to the top. With a
  // query the ordering is unchanged (rank, then `updated_at`).
  //
  // The platform filter and the optional folder filter apply in both modes.
  // `folderProjects` matches `metadata.project`, the folder label generation
  // copies from the server session; rows without a label are excluded when it
  // is set. Labels compare case-insensitively over ASCII only, exactly like the
  // SQLite read path's COLLATE NOCASE (#3536): `lower()` under the "C"
  // collation folds A-Z and nothing else, whatever the database locale, so
  // checkouts named `PasteyPal` and `pasteypal` share one bucket on both
  // runtimes while `École` and `école` stay apart on both.
  //
  // `excludeSubagents` (CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY) leaves out rows
  // generated from a subagent's hook event: one whose payload carries BOTH an
  // agentId and an agentType (src/shared/subagent-predicate.ts). An agent id
  // alone is main-agent work (transcript-watch seats), and rows with no event
  // source (summaries, direct memories) always stay.
  //
  // `queryEmbedding` (the query's vector and the model that made it, from
  // embedSearchQuery) turns a query search hybrid: see searchHybrid. Without
  // it, or without a query, the read is the keyword/recency one below.
  async search(input: {
    projectId: string;
    teamId: string;
    query?: string | null;
    limit?: number;
    platformSource?: string | null;
    folderProjects?: string[] | null;
    excludeSubagents?: boolean;
    queryEmbedding?: { vector: ArrayLike<number>; model: string } | null;
    /** Select summaries (true) or observations (false); omit for both. */
    summary?: boolean;
  }): Promise<PostgresObservation[]> {
    const platformSource = normalizePlatformSourceOrNull(input.platformSource);
    const query = input.query && input.query.trim().length > 0 ? input.query : null;
    const folderProjects = input.folderProjects && input.folderProjects.length > 0
      ? input.folderProjects
      : null;
    if (query && input.queryEmbedding) {
      const legCandidates = Math.max(HYBRID_LEG_CANDIDATES, input.limit ?? 20);
      return this.searchHybrid([
        input.projectId,
        input.teamId,
        query,
        input.limit ?? 20,
        platformSource,
        folderProjects,
        input.excludeSubagents === true,
        input.summary ?? null,
        legCandidates,
        toVectorLiteral(input.queryEmbedding.vector),
        legCandidates * (HYBRID_NEAREST_PARTS / HYBRID_LEG_CANDIDATES),
        input.queryEmbedding.model,
      ]);
    }
    // On postgres-pgvector-textsearch, a query matches any of its terms,
    // ranked by bm25 through the pg_textsearch index's scan, which scores rows
    // as it yields them; naming the score anywhere else would score each row
    // again outside the index, at milliseconds a row. The scan yields rows with
    // no query term last, scored 0, once the matches run out; matches_query
    // marks those to drop. Elsewhere the query is unchanged.
    const bm25 = query !== null && usesBm25Index(this.client);
    // A query written with web-search syntax (a quoted phrase, -term, or) keeps
    // the websearch_to_tsquery match it always had, so phrases, exclusions and
    // alternatives still mean what they say; bm25 only ranks those matches.
    // Plain words match any term on the bm25 path.
    const bm25MatchesAnyTerm = bm25 && !usesWebsearchSyntax(query);
    const result = await this.client.query<ObservationRow & { matches_query?: boolean }>(
      `
        SELECT observations.*,
          COALESCE(NULLIF(server_sessions.content_session_id, ''), server_sessions.external_session_id) AS content_session_id
          ${bm25MatchesAnyTerm ? `, observations.content_search @@ ${ANY_TERM_TSQUERY_SQL} AS matches_query` : ''}
        FROM observations
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE ${SEARCH_SCOPE_SQL}
          ${bm25MatchesAnyTerm ? '' : "AND ($3::text IS NULL OR observations.content_search @@ websearch_to_tsquery('english', $3))"}
        ORDER BY ${bm25
          ? bm25Order('$3')
          : `CASE WHEN $3::text IS NULL THEN observations.created_at END DESC,
          ts_rank(observations.content_search, websearch_to_tsquery('english', $3)) DESC,
          observations.updated_at DESC`}
        LIMIT $4
      `,
      [
        input.projectId,
        input.teamId,
        query,
        input.limit ?? 20,
        platformSource,
        folderProjects,
        input.excludeSubagents === true,
        input.summary ?? null,
      ]
    );
    return result.rows.filter(row => !bm25MatchesAnyTerm || row.matches_query).map(mapObservationRow);
  }

  // Keyword and vector ranking fused by reciprocal rank fusion. Each leg ranks
  // its own candidates under the same scope filters; an observation scores
  // 1/(k + rank) per leg it appears in, so one found by both outranks one found
  // by either alone, and a paraphrase that matches no keyword is still found.
  // The keyword leg ranks as search() does: by bm25 on
  // postgres-pgvector-textsearch, by every term and ts_rank elsewhere. The
  // vector leg takes the project's nearest parts from the HNSW index and ranks
  // an observation by its nearest part. Only parts from the query's own model
  // are compared: while rows are re-embedded after a model change, the others
  // are in another model's space, where distance means nothing.
  private async searchHybrid(params: unknown[]): Promise<PostgresObservation[]> {
    // The bm25 candidates come in the index scan's order, numbered as they
    // come; the score is not named outside ORDER BY, so the scan is not
    // rescored (see search()). The LIMIT keeps the planner from pushing the
    // match filter into the scan, which would walk the whole index whenever
    // fewer than $9 rows match. A query in web-search syntax keeps its
    // websearch_to_tsquery match, as in search().
    const keyword = usesBm25Index(this.client) && !usesWebsearchSyntax(String(params[2]))
      ? `
      keyword AS (
        SELECT id, row_number() OVER () AS rank
        FROM (
          SELECT observations.id,
            observations.content_search @@ ${ANY_TERM_TSQUERY_SQL} AS matches_query
          FROM observations
          LEFT JOIN server_sessions
            ON server_sessions.id = observations.server_session_id
            AND server_sessions.project_id = observations.project_id
            AND server_sessions.team_id = observations.team_id
          WHERE ${SEARCH_SCOPE_SQL}
          ORDER BY ${bm25Order('$3')}
          LIMIT $9
        ) AS candidates
        WHERE matches_query
      )`
      : `
      keyword AS (
        SELECT observations.id,
          row_number() OVER (
            ORDER BY ts_rank(observations.content_search, websearch_to_tsquery('english', $3)) DESC,
              observations.updated_at DESC
          ) AS rank
        FROM observations
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE ${SEARCH_SCOPE_SQL}
          AND observations.content_search @@ websearch_to_tsquery('english', $3)
        ORDER BY rank
        LIMIT $9
      )`;
    // A folder, platform, subagent or summary filter applies before the
    // nearest-parts cutoff, not after it: otherwise parts from rows the filter
    // drops can fill the cutoff and leave none of the rows it keeps.
    const [, , , , platformSource, folderProjects, excludeSubagents, summary] = params;
    const narrowed = platformSource !== null || folderProjects !== null || excludeSubagents === true || summary !== null;
    const sql = `
      WITH ${keyword},
      nearest AS (${narrowed
        ? `
        SELECT e.observation_id, e.embedding <=> $10::vector AS distance
        FROM observation_embeddings e
        INNER JOIN observations ON observations.id = e.observation_id
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE e.project_id = $1 AND e.team_id = $2 AND e.model = $12 AND ${SEARCH_SCOPE_SQL}
        ORDER BY e.embedding <=> $10::vector`
        : `
        SELECT observation_id, embedding <=> $10::vector AS distance
        FROM observation_embeddings
        WHERE project_id = $1 AND team_id = $2 AND model = $12
        ORDER BY embedding <=> $10::vector`}
        LIMIT $11
      ),
      semantic AS (
        SELECT observations.id,
          row_number() OVER (ORDER BY min(nearest.distance)) AS rank
        FROM nearest
        INNER JOIN observations ON observations.id = nearest.observation_id
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE ${SEARCH_SCOPE_SQL}
        GROUP BY observations.id
        ORDER BY rank
        LIMIT $9
      ),
      fused AS (
        SELECT id, sum(1.0 / (${RRF_K} + rank)) AS score
        FROM (SELECT id, rank FROM keyword UNION ALL SELECT id, rank FROM semantic) AS legs
        GROUP BY id
      )
      SELECT observations.*,
        COALESCE(NULLIF(server_sessions.content_session_id, ''), server_sessions.external_session_id) AS content_session_id,
        (SELECT count(*) FROM nearest)::int AS nearest_parts_read,
        (SELECT count(*) FROM semantic)::int AS semantic_candidates
      FROM fused
      INNER JOIN observations ON observations.id = fused.id
      LEFT JOIN server_sessions
        ON server_sessions.id = observations.server_session_id
        AND server_sessions.project_id = observations.project_id
        AND server_sessions.team_id = observations.team_id
      ORDER BY fused.score DESC, observations.updated_at DESC
      LIMIT $4
    `;
    // An HNSW scan returns at most hnsw.ef_search rows (default 40), so the
    // nearest-parts LIMIT is only honoured with ef_search raised to match.
    // The scan is filtered to one project, and an iterative scan keeps reading
    // the index until enough of that project's parts are found, rather than
    // filtering the nearest parts of every project down to few or none.
    // SET LOCAL needs a transaction, hence a dedicated connection from a pool.
    //
    // The nearest-parts cutoff counts parts, not observations, and one
    // observation can have dozens (a part per fact), so a few fact-heavy
    // observations can fill it and leave the vector leg with fewer than $9
    // observations. When that happens and the cutoff was reached, the read
    // runs again with four times the parts, until the leg is full, the
    // project has no more parts, or every candidate could have its maximum
    // number of parts.
    const legCandidates = Number(params[8]);
    const maxNearestParts = legCandidates * MAX_PARTS_PER_OBSERVATION;
    const run = async (client: PostgresQueryable) => {
      await client.query(`SET LOCAL hnsw.iterative_scan = strict_order`);
      let nearestParts = Number(params[10]);
      for (;;) {
        // pgvector rejects a value above 1000, which a limit above 250 would ask for.
        await client.query(`SET LOCAL hnsw.ef_search = ${Math.min(1000, nearestParts)}`);
        const attempt = await client.query<HybridSearchRow>(sql, [...params.slice(0, 10), nearestParts, ...params.slice(11)]);
        const first = attempt.rows[0];
        const legIsShort = first !== undefined
          && first.semantic_candidates < legCandidates
          && first.nearest_parts_read >= nearestParts;
        if (!legIsShort || nearestParts >= maxNearestParts) return attempt;
        nearestParts = Math.min(maxNearestParts, nearestParts * 4);
      }
    };
    const result = isPool(this.client)
      ? await withPostgresTransaction(this.client, run)
      : await run(this.client);
    return result.rows.map(({ nearest_parts_read: _parts, semantic_candidates: _candidates, ...row }) => mapObservationRow(row));
  }
}

export class PostgresObservationSourcesRepository {
  constructor(private client: PostgresQueryable) {}

  async addSource(input: {
    id?: string;
    observationId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId?: string | null;
    generationJobId?: string | null;
    metadata?: JsonObject;
  }): Promise<PostgresObservationSource> {
    const observation = await queryOne<{ id: string }>(
      this.client,
      'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.observationId, input.projectId, input.teamId]
    );
    if (!observation) {
      throw new Error('observation_id does not exist');
    }

    const agentEventId = input.sourceType === 'agent_event'
      ? input.agentEventId ?? input.sourceId
      : null;

    if (input.sourceType === 'agent_event') {
      if (agentEventId !== input.sourceId) {
        throw new Error('agent_event source_id must equal agent_event_id');
      }
      await assertAgentEventOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'session_summary' && !input.generationJobId) {
      await assertSessionOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'observation_reindex' && !input.generationJobId) {
      await assertObservationOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    }
    if (input.generationJobId) {
      await assertGenerationJobMatchesSource(this.client, {
        generationJobId: input.generationJobId,
        projectId: input.projectId,
        teamId: input.teamId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        agentEventId
      });
    }

    const row = await queryOne<ObservationSourceRow>(
      this.client,
      `
        INSERT INTO observation_sources (
          id, observation_id, agent_event_id, generation_job_id,
          source_type, source_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (observation_id, source_type, source_id) DO UPDATE SET
          metadata = observation_sources.metadata || excluded.metadata
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.observationId,
        agentEventId,
        input.generationJobId ?? null,
        input.sourceType,
        input.sourceId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return mapObservationSourceRow(row!);
  }

  async listByObservationForScope(input: {
    observationId: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservationSource[]> {
    const result = await this.client.query<ObservationSourceRow>(
      `
        SELECT observation_sources.*
        FROM observation_sources
        INNER JOIN observations
          ON observations.id = observation_sources.observation_id
        WHERE observation_sources.observation_id = $1
          AND observations.project_id = $2
          AND observations.team_id = $3
        ORDER BY observation_sources.created_at ASC
      `,
      [input.observationId, input.projectId, input.teamId]
    );
    return result.rows.map(mapObservationSourceRow);
  }
}

export function buildObservationGenerationKey(input: {
  generationJobId: string;
  parsedObservationIndex: number;
  content: string;
}): string {
  return `generation:v1:${input.generationJobId}:${input.parsedObservationIndex}:${deterministicKey([
    canonicalJson(input.content.trim())
  ])}`;
}

async function assertJobOwnership(
  client: PostgresQueryable,
  generationJobId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observation_generation_jobs WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [generationJobId, projectId, teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
}

async function assertGenerationJobMatchesSource(
  client: PostgresQueryable,
  input: {
    generationJobId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId: string | null;
  }
): Promise<void> {
  if (input.sourceType === 'manual') {
    throw new Error('manual observation sources cannot be linked to a generation_job_id');
  }

  const row = await queryOne<{
    id: string;
    source_type: string;
    source_id: string;
    agent_event_id: string | null;
  }>(
    client,
    `
      SELECT id, source_type, source_id, agent_event_id
      FROM observation_generation_jobs
      WHERE id = $1 AND project_id = $2 AND team_id = $3
    `,
    [input.generationJobId, input.projectId, input.teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
  if (row.source_type !== input.sourceType || row.source_id !== input.sourceId) {
    throw new Error('generation_job_id source model must match observation source');
  }
  if (input.sourceType === 'agent_event' && row.agent_event_id !== input.agentEventId) {
    throw new Error('generation_job_id agent_event_id must match observation source');
  }
}

async function assertAgentEventOwnership(
  client: PostgresQueryable,
  agentEventId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM agent_events WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [agentEventId, projectId, teamId]
  );
  if (!row) {
    throw new Error('agent_event_id must belong to project_id and team_id');
  }
}

async function assertObservationOwnership(
  client: PostgresQueryable,
  observationId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [observationId, projectId, teamId]
  );
  if (!row) {
    throw new Error('observation_reindex source_id must belong to project_id and team_id');
  }
}

function mapObservationRow(row: ObservationRow): PostgresObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    ...(row.content_session_id !== undefined ? { contentSessionId: row.content_session_id } : {}),
    kind: row.kind,
    content: row.content,
    generationKey: row.generation_key,
    metadata: toJsonObject(row.metadata),
    embedding: row.embedding,
    createdByJobId: row.created_by_job_id,
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}

function mapObservationSourceRow(row: ObservationSourceRow): PostgresObservationSource {
  return {
    id: row.id,
    observationId: row.observation_id,
    agentEventId: row.agent_event_id,
    generationJobId: row.generation_job_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at)
  };
}
