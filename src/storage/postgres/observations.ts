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

export type ObservationSourceType = 'agent_event' | 'session_summary' | 'observation_reindex' | 'manual';

export interface PostgresObservation {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
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

  async search(input: {
    projectId: string;
    teamId: string;
    query: string;
    limit?: number;
    // optional platform_source filter (server_sessions.platform_source).
    // When set, only return observations whose server_session was tagged with
    // the matching platform_source. The platform_source column lives on
    // server_sessions, not observations, so we LEFT JOIN to keep observations
    // that have no session (kind='manual' inserts) visible — they are excluded
    // only when a platform_source filter is explicitly requested.
    platformSource?: string | null;
  }): Promise<PostgresObservation[]> {
    const params: unknown[] = [input.projectId, input.teamId, input.query, input.limit ?? 20];
    let platformClause = '';
    if (typeof input.platformSource === 'string' && input.platformSource.trim().length > 0) {
      params.push(input.platformSource);
      // fix — platform_source filter must also match observations whose
      // source agent_event has a matching source_adapter. Without this, events
      // ingested without an explicit session (the common hook path) produce
      // observations that are invisible to a platform-scoped search. We accept
      // EITHER a session-level platform_source match OR an agent_event-level
      // source_adapter match for the same value (semantically equivalent).
      platformClause = `AND (
        ss.platform_source = $${params.length}
        OR EXISTS (
          SELECT 1 FROM observation_sources os2
          JOIN agent_events ae ON ae.id = os2.agent_event_id
          WHERE os2.observation_id = o.id AND ae.source_adapter = $${params.length}
        )
      )`;
    }
    const result = await this.client.query<ObservationRow>(
      `
        SELECT o.*
        FROM observations o
        LEFT JOIN server_sessions ss ON ss.id = o.server_session_id
        WHERE o.project_id = $1
          AND o.team_id = $2
          AND o.content_search @@ websearch_to_tsquery('english', $3)
          ${platformClause}
        ORDER BY ts_rank(o.content_search, websearch_to_tsquery('english', $3)) DESC, o.updated_at DESC
        LIMIT $4
      `,
      params
    );
    return result.rows.map(mapObservationRow);
  }

  // Branch 2 (Agent C, master plan) — batch get for MCP's `get_observations`
  // tool. Scoped by team_id mandatorily; project_id is optional (when omitted
  // the caller is implicitly trusting the api-key team scope to be enough).
  // Both scopes are applied as SQL predicates so a leaked id cannot reveal
  // a foreign tenant's observation.
  async findByIdsForScope(input: {
    teamId: string;
    projectId?: string | null;
    ids: string[];
  }): Promise<PostgresObservation[]> {
    if (input.ids.length === 0) return [];
    const params: unknown[] = [input.teamId, input.ids];
    let projectClause = '';
    if (typeof input.projectId === 'string' && input.projectId.length > 0) {
      params.push(input.projectId);
      projectClause = `AND project_id = $${params.length}`;
    }
    const result = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE team_id = $1
          AND id = ANY($2::text[])
          ${projectClause}
        ORDER BY created_at DESC
      `,
      params,
    );
    return result.rows.map(mapObservationRow);
  }

  // Branch 2 — single get by id, team-scoped only. Mirrors /v1/events/:id
  // pattern: scan by team + id, callers extract project_id and run
  // ensureProjectAllowed for the api-key project gate.
  async getByIdForTeam(input: {
    teamId: string;
    id: string;
  }): Promise<PostgresObservation | null> {
    const row = await queryOne<ObservationRow>(
      this.client,
      'SELECT * FROM observations WHERE id = $1 AND team_id = $2',
      [input.id, input.teamId],
    );
    return row ? mapObservationRow(row) : null;
  }

  // Branch 2 — timeline window. Given an anchor observation id (or a query
  // string that resolves to the top-ranked search hit), return N observations
  // created BEFORE the anchor and N created AFTER. created_at is the ordering
  // key (tsvector is irrelevant here). anchorId/query are mutually exclusive;
  // if both are passed, anchorId wins.
  async timelineWindow(input: {
    projectId: string;
    teamId: string;
    anchorObservationId?: string;
    query?: string;
    depthBefore: number;
    depthAfter: number;
  }): Promise<{
    anchor: PostgresObservation | null;
    before: PostgresObservation[];
    after: PostgresObservation[];
  }> {
    let anchor: PostgresObservation | null = null;
    if (input.anchorObservationId) {
      const row = await queryOne<ObservationRow>(
        this.client,
        'SELECT * FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
        [input.anchorObservationId, input.projectId, input.teamId],
      );
      if (row) anchor = mapObservationRow(row);
    } else if (input.query && input.query.length > 0) {
      const top = await this.client.query<ObservationRow>(
        `
          SELECT * FROM observations
          WHERE project_id = $1
            AND team_id = $2
            AND content_search @@ websearch_to_tsquery('english', $3)
          ORDER BY ts_rank(content_search, websearch_to_tsquery('english', $3)) DESC, updated_at DESC
          LIMIT 1
        `,
        [input.projectId, input.teamId, input.query],
      );
      if (top.rows[0]) anchor = mapObservationRow(top.rows[0]);
    }

    if (!anchor) {
      return { anchor: null, before: [], after: [] };
    }

    const anchorTs = new Date(anchor.createdAtEpoch).toISOString();
    const beforeResult = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND id <> $3
          AND created_at <= $4::timestamptz
        ORDER BY created_at DESC
        LIMIT $5
      `,
      [input.projectId, input.teamId, anchor.id, anchorTs, Math.max(0, input.depthBefore)],
    );
    const afterResult = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND id <> $3
          AND created_at >= $4::timestamptz
        ORDER BY created_at ASC
        LIMIT $5
      `,
      [input.projectId, input.teamId, anchor.id, anchorTs, Math.max(0, input.depthAfter)],
    );
    return {
      anchor,
      before: beforeResult.rows.map(mapObservationRow),
      after: afterResult.rows.map(mapObservationRow),
    };
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
