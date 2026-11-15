// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import { AgentEventSchema, CreateAgentEventSchema, type AgentEvent, type AgentEventSourceType, type CreateAgentEvent } from '../../core/schemas/agent-event.js';
import { ensureServerStorageSchema } from './schema.js';
import { redactJsonStrings } from '../../utils/redaction.js';
import { stripMemoryTagsFromJsonStrings } from '../../utils/tag-stripping.js';
import { logger } from '../../utils/logger.js';

interface AgentEventRow {
  id: string;
  project_id: string;
  server_session_id: string | null;
  source_type: AgentEventSourceType;
  event_type: string;
  payload: string;
  content_session_id: string | null;
  memory_session_id: string | null;
  occurred_at_epoch: number;
  created_at_epoch: number;
}

/**
 * `payload` is any JSON value (`z.unknown()`), written through `create`, but a
 * row can also be written by another process or left half-written. An
 * unreadable payload reads as the schema's empty object instead of throwing
 * out of `getById`/`listByProject`, which sit on the server's request path: one
 * bad row would otherwise fail every read of the table. The raw payload is
 * never logged, only the event id.
 */
function parseStoredPayload(raw: string, eventId: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logger.warn(
      'DB',
      'Unreadable agent event payload; reading it as an empty object',
      { eventId },
      error instanceof Error ? error : new Error(String(error))
    );
    return {};
  }
}

function mapAgentEventRow(row: AgentEventRow): AgentEvent {
  return AgentEventSchema.parse({
    id: row.id,
    projectId: row.project_id,
    serverSessionId: row.server_session_id,
    sourceType: row.source_type,
    eventType: row.event_type,
    payload: parseStoredPayload(row.payload, row.id),
    contentSessionId: row.content_session_id,
    memorySessionId: row.memory_session_id,
    occurredAtEpoch: row.occurred_at_epoch,
    createdAtEpoch: row.created_at_epoch
  });
}

export class AgentEventsRepository {
  constructor(private db: Database) {
    ensureServerStorageSchema(this.db);
  }

  create(input: CreateAgentEvent): AgentEvent {
    const event = CreateAgentEventSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO agent_events (
        id, project_id, server_session_id, source_type, event_type, payload,
        content_session_id, memory_session_id, occurred_at_epoch, created_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.projectId,
      event.serverSessionId ?? null,
      event.sourceType,
      event.eventType,
      // Raw event bodies are stored as-is, so <private> removal and opt-in
      // secret redaction (#2616) apply here, at the one write every ingest
      // path goes through.
      JSON.stringify(redactJsonStrings(stripMemoryTagsFromJsonStrings(event.payload ?? {}))),
      event.contentSessionId ?? null,
      event.memorySessionId ?? null,
      event.occurredAtEpoch,
      now
    );

    return this.getById(id)!;
  }

  getById(id: string): AgentEvent | null {
    const row = this.db.prepare('SELECT * FROM agent_events WHERE id = ?').get(id) as AgentEventRow | null;
    return row ? mapAgentEventRow(row) : null;
  }

  listByProject(projectId: string, limit = 100): AgentEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_events
      WHERE project_id = ?
      ORDER BY occurred_at_epoch DESC
      LIMIT ?
    `).all(projectId, limit) as AgentEventRow[];
    return rows.map(mapAgentEventRow);
  }
}
