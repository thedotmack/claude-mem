// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { assertProjectOwnership, deterministicKey, newId, queryOne, toDate, toEpoch, toJsonObject } from './utils.js';

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
