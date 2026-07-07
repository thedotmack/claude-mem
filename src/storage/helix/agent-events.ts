import { randomUUID } from 'crypto'
import { AgentEventSchema, CreateAgentEventSchema, type AgentEvent, type CreateAgentEvent } from '../../core/schemas/agent-event.js'
import type { HelixNode, HelixTransport } from './transport.js'

function mapAgentEventRow(row: HelixNode): AgentEvent {
  return AgentEventSchema.parse({
    id: row.id,
    projectId: row.project_id,
    serverSessionId: row.server_session_id ?? null,
    sourceType: row.source_type,
    eventType: row.event_type,
    platformSource: row.platform_source ?? null,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : {},
    contentSessionId: row.content_session_id ?? null,
    memorySessionId: row.memory_session_id ?? null,
    occurredAtEpoch: row.occurred_at_epoch,
    createdAtEpoch: row.created_at_epoch
  })
}

export class HelixAgentEventsRepository {
  constructor(private readonly transport: HelixTransport) {}

  async create(input: CreateAgentEvent): Promise<AgentEvent> {
    const event = CreateAgentEventSchema.parse(input)
    if (event.serverSessionId) {
      const sessions = await this.transport.findNodes('ServerSession', {
        id: event.serverSessionId,
        project_id: event.projectId
      })
      if (sessions.length === 0) {
        throw new Error('agent_events server_session_id must belong to project_id')
      }
    }

    const now = Date.now()
    const row = await this.transport.insertNode('AgentEvent', {
      id: randomUUID(),
      project_id: event.projectId,
      server_session_id: event.serverSessionId ?? null,
      source_type: event.sourceType,
      event_type: event.eventType,
      platform_source: event.platformSource ?? null,
      payload: JSON.stringify(event.payload ?? {}),
      content_session_id: event.contentSessionId ?? null,
      memory_session_id: event.memorySessionId ?? null,
      occurred_at_epoch: event.occurredAtEpoch,
      created_at_epoch: now
    })
    return mapAgentEventRow(row)
  }

  async getById(id: string): Promise<AgentEvent | null> {
    const rows = await this.transport.findNodes('AgentEvent', { id })
    return rows[0] ? mapAgentEventRow(rows[0]) : null
  }

  async listByProject(projectId: string, limit = 100): Promise<AgentEvent[]> {
    const rows = await this.transport.findNodes('AgentEvent', { project_id: projectId })
    return rows
      .map(mapAgentEventRow)
      .sort((left, right) => right.occurredAtEpoch - left.occurredAtEpoch)
      .slice(0, limit)
  }
}

