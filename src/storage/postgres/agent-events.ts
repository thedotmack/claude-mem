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

export interface PostgresAgentEvent {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  sourceAdapter: string;
  sourceEventId: string | null;
  idempotencyKey: string;
  eventType: string;
  payload: JsonValue;
  metadata: JsonObject;
  occurredAtEpoch: number;
  receivedAtEpoch: number;
  createdAtEpoch: number;
}

export interface CreatePostgresAgentEventInput {
  id?: string;
  projectId: string;
  teamId: string;
  serverSessionId?: string | null;
  sourceAdapter: string;
  sourceEventId?: string | null;
  eventType: string;
  payload?: JsonValue;
  metadata?: JsonObject;
  occurredAt: Date | string | number;
}

interface AgentEventRow {
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

export class PostgresAgentEventsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: CreatePostgresAgentEventInput): Promise<PostgresAgentEvent> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    if (input.serverSessionId) {
      await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
    }
    const idempotencyKey = buildAgentEventIdempotencyKey(input);
    const row = await queryOne<AgentEventRow>(
      this.client,
      `
        INSERT INTO agent_events (
          id, project_id, team_id, server_session_id, source_adapter,
          source_event_id, idempotency_key, event_type, payload, metadata, occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
        ON CONFLICT (idempotency_key) DO UPDATE SET
          metadata = agent_events.metadata || excluded.metadata
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.projectId,
        input.teamId,
        input.serverSessionId ?? null,
        input.sourceAdapter,
        input.sourceEventId ?? null,
        idempotencyKey,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        JSON.stringify(input.metadata ?? {}),
        new Date(input.occurredAt)
      ]
    );
    return mapAgentEventRow(row!);
  }

  async createMany(inputs: CreatePostgresAgentEventInput[]): Promise<PostgresAgentEvent[]> {
    const events: PostgresAgentEvent[] = [];
    for (const input of inputs) {
      events.push(await this.create(input));
    }
    return events;
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresAgentEvent | null> {
    const row = await queryOne<AgentEventRow>(
      this.client,
      'SELECT * FROM agent_events WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapAgentEventRow(row) : null;
  }

  async listByProject(input: {
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    limit?: number;
  }): Promise<PostgresAgentEvent[]> {
    const result = await this.client.query<AgentEventRow>(
      `
        SELECT * FROM agent_events
        WHERE project_id = $1
          AND team_id = $2
          AND ($3::text IS NULL OR server_session_id = $3)
        ORDER BY occurred_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, input.serverSessionId ?? null, input.limit ?? 100]
    );
    return result.rows.map(mapAgentEventRow);
  }
}

export function buildAgentEventIdempotencyKey(input: {
  teamId: string;
  projectId: string;
  sourceAdapter: string;
  sourceEventId?: string | null;
  serverSessionId?: string | null;
  eventType: string;
  occurredAt: Date | string | number;
  payload?: JsonValue;
}): string {
  if (input.sourceEventId) {
    return `agent_event:v1:${deterministicKey([
      input.teamId,
      input.projectId,
      input.sourceAdapter,
      input.sourceEventId
    ])}`;
  }

  return `agent_event:v1:${deterministicKey([
    input.teamId,
    input.projectId,
    input.sourceAdapter,
    input.serverSessionId ?? null,
    input.eventType,
    new Date(input.occurredAt).toISOString(),
    canonicalJson(input.payload ?? {})
  ])}`;
}

function mapAgentEventRow(row: AgentEventRow): PostgresAgentEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    sourceAdapter: row.source_adapter,
    sourceEventId: row.source_event_id,
    idempotencyKey: row.idempotency_key,
    eventType: row.event_type,
    payload: row.payload,
    metadata: toJsonObject(row.metadata),
    occurredAtEpoch: toEpoch(row.occurred_at),
    receivedAtEpoch: toEpoch(row.received_at),
    createdAtEpoch: toEpoch(row.created_at)
  };
}
