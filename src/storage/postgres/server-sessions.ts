// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { assertProjectOwnership, deterministicKey, newId, queryOne, toDate, toEpoch, toJsonObject } from './utils.js';
import type { PostgresAgentEvent } from './agent-events.js';

export interface PostgresServerSession {
  id: string;
  projectId: string;
  teamId: string;
  externalSessionId: string | null;
  idempotencyKey: string | null;
  contentSessionId: string | null;
  agentId: string | null;
  agentType: string | null;
  platformSource: string | null;
  generationStatus: string;
  metadata: JsonObject;
  startedAtEpoch: number;
  endedAtEpoch: number | null;
  lastGeneratedAtEpoch: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface ServerSessionRow {
  id: string;
  project_id: string;
  team_id: string;
  external_session_id: string | null;
  idempotency_key: string | null;
  content_session_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  platform_source: string | null;
  generation_status: string;
  metadata: unknown;
  started_at: Date;
  ended_at: Date | null;
  last_generated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class PostgresServerSessionsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    projectId: string;
    teamId: string;
    externalSessionId?: string | null;
    contentSessionId?: string | null;
    agentId?: string | null;
    agentType?: string | null;
    platformSource?: string | null;
    generationStatus?: string;
    metadata?: JsonObject;
  }): Promise<PostgresServerSession> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    const id = input.id ?? newId();
    const idempotencyKey = buildServerSessionIdempotencyKey(input);
    const row = await queryOne<ServerSessionRow>(
      this.client,
      `
        INSERT INTO server_sessions (
          id, project_id, team_id, external_session_id, idempotency_key, content_session_id,
          agent_id, agent_type, platform_source, generation_status, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
          external_session_id = excluded.external_session_id,
          content_session_id = excluded.content_session_id,
          agent_id = excluded.agent_id,
          agent_type = excluded.agent_type,
          platform_source = excluded.platform_source,
          generation_status = excluded.generation_status,
          metadata = excluded.metadata,
          updated_at = now()
        RETURNING *
      `,
      [
        id,
        input.projectId,
        input.teamId,
        input.externalSessionId ?? null,
        idempotencyKey,
        input.contentSessionId ?? null,
        input.agentId ?? null,
        input.agentType ?? null,
        input.platformSource ?? null,
        input.generationStatus ?? 'idle',
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return mapServerSessionRow(row!);
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresServerSession | null> {
    const row = await queryOne<ServerSessionRow>(
      this.client,
      'SELECT * FROM server_sessions WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapServerSessionRow(row) : null;
  }

  async listByProject(projectId: string, teamId: string): Promise<PostgresServerSession[]> {
    const result = await this.client.query<ServerSessionRow>(
      `
        SELECT * FROM server_sessions
        WHERE project_id = $1 AND team_id = $2
        ORDER BY started_at DESC
      `,
      [projectId, teamId]
    );
    return result.rows.map(mapServerSessionRow);
  }

  async findByExternalIdForScope(input: {
    externalSessionId: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresServerSession | null> {
    const row = await queryOne<ServerSessionRow>(
      this.client,
      `
        SELECT * FROM server_sessions
        WHERE external_session_id = $1 AND project_id = $2 AND team_id = $3
      `,
      [input.externalSessionId, input.projectId, input.teamId]
    );
    return row ? mapServerSessionRow(row) : null;
  }

  /**
   * End a server session by setting `ended_at = now()` if not already set.
   * Idempotent: if `ended_at` is already populated, returns the row unchanged.
   * Returns null if no row matches the (id, project_id, team_id) tuple.
   */
  async endSession(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresServerSession | null> {
    const updated = await queryOne<ServerSessionRow>(
      this.client,
      `
        UPDATE server_sessions
        SET ended_at = COALESCE(ended_at, now()),
            updated_at = CASE WHEN ended_at IS NULL THEN now() ELSE updated_at END
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [input.id, input.projectId, input.teamId]
    );
    return updated ? mapServerSessionRow(updated) : null;
  }

  async markGenerationStarted(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresServerSession | null> {
    const updated = await queryOne<ServerSessionRow>(
      this.client,
      `
        UPDATE server_sessions
        SET generation_status = 'processing', updated_at = now()
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [input.id, input.projectId, input.teamId]
    );
    return updated ? mapServerSessionRow(updated) : null;
  }

  async markGenerationCompleted(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresServerSession | null> {
    const updated = await queryOne<ServerSessionRow>(
      this.client,
      `
        UPDATE server_sessions
        SET generation_status = 'completed',
            last_generated_at = now(),
            updated_at = now()
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [input.id, input.projectId, input.teamId]
    );
    return updated ? mapServerSessionRow(updated) : null;
  }

  async markGenerationFailed(input: {
    id: string;
    projectId: string;
    teamId: string;
    error?: string | null;
  }): Promise<PostgresServerSession | null> {
    const updated = await queryOne<ServerSessionRow>(
      this.client,
      `
        UPDATE server_sessions
        SET generation_status = 'failed',
            metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{lastGenerationError}',
              COALESCE(to_jsonb($4::text), 'null'::jsonb),
              true
            ),
            updated_at = now()
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [input.id, input.projectId, input.teamId, input.error ?? null]
    );
    return updated ? mapServerSessionRow(updated) : null;
  }

  /**
   * List events tied to this server_session that do NOT yet have a completed
   * observation_generation_jobs row. Tenant-scoped: rows are filtered by
   * (project_id, team_id) before any join.
   */
  async listUnprocessedEvents(input: {
    serverSessionId: string;
    projectId: string;
    teamId: string;
    limit?: number;
  }): Promise<PostgresAgentEvent[]> {
    const limit = input.limit ?? 500;
    const result = await this.client.query<UnprocessedEventRow>(
      `
        SELECT e.*
        FROM agent_events e
        WHERE e.server_session_id = $1
          AND e.project_id = $2
          AND e.team_id = $3
          AND NOT EXISTS (
            SELECT 1 FROM observation_generation_jobs j
            WHERE j.agent_event_id = e.id
              AND j.project_id = e.project_id
              AND j.team_id = e.team_id
              AND j.source_type = 'agent_event'
              AND j.status = 'completed'
          )
        ORDER BY e.occurred_at ASC
        LIMIT $4
      `,
      [input.serverSessionId, input.projectId, input.teamId, limit]
    );
    return result.rows.map(mapUnprocessedEventRow);
  }
}

interface UnprocessedEventRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  source_adapter: string;
  source_event_id: string | null;
  idempotency_key: string;
  event_type: string;
  payload: unknown;
  metadata: unknown;
  occurred_at: Date;
  received_at: Date;
  created_at: Date;
}

function mapUnprocessedEventRow(row: UnprocessedEventRow): PostgresAgentEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    sourceAdapter: row.source_adapter,
    sourceEventId: row.source_event_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    payload: toJsonObject(row.payload),
    metadata: toJsonObject(row.metadata),
    occurredAtEpoch: row.occurred_at.getTime(),
    receivedAtEpoch: row.received_at.getTime(),
    createdAtEpoch: row.created_at.getTime()
  };
}

export function buildServerSessionIdempotencyKey(input: {
  projectId: string;
  teamId: string;
  externalSessionId?: string | null;
  contentSessionId?: string | null;
  agentId?: string | null;
  agentType?: string | null;
  platformSource?: string | null;
}): string | null {
  if (input.externalSessionId) {
    return `server_session:v1:${deterministicKey([
      input.teamId,
      input.projectId,
      'external',
      input.externalSessionId
    ])}`;
  }

  if (input.contentSessionId) {
    return `server_session:v1:${deterministicKey([
      input.teamId,
      input.projectId,
      'content',
      input.platformSource ?? null,
      input.agentId ?? null,
      input.contentSessionId
    ])}`;
  }

  if (input.agentId && input.platformSource) {
    return `server_session:v1:${deterministicKey([
      input.teamId,
      input.projectId,
      'agent',
      input.platformSource,
      input.agentId,
      input.agentType ?? null
    ])}`;
  }

  return null;
}

function mapServerSessionRow(row: ServerSessionRow): PostgresServerSession {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    externalSessionId: row.external_session_id,
    idempotencyKey: row.idempotency_key,
    contentSessionId: row.content_session_id,
    agentId: row.agent_id,
    agentType: row.agent_type,
    platformSource: row.platform_source,
    generationStatus: row.generation_status,
    metadata: toJsonObject(row.metadata),
    startedAtEpoch: toEpoch(row.started_at),
    endedAtEpoch: toDate(row.ended_at)?.getTime() ?? null,
    lastGeneratedAtEpoch: toDate(row.last_generated_at)?.getTime() ?? null,
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}
