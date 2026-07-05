import { randomUUID } from 'crypto'
import { CreateServerSessionSchema, ServerSessionSchema, type CreateServerSession, type ServerSession } from '../../core/schemas/session.js'
import { parseJsonObject, stringifyJson } from '../sqlite/serde.js'
import type { HelixNode, HelixTransport } from './transport.js'

function mapServerSessionRow(row: HelixNode): ServerSession {
  return ServerSessionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    contentSessionId: row.content_session_id ?? null,
    memorySessionId: row.memory_session_id ?? null,
    platformSource: row.platform_source ?? 'claude',
    title: row.title ?? null,
    status: row.status ?? 'active',
    metadata: parseJsonObject(typeof row.metadata === 'string' ? row.metadata : '{}'),
    startedAtEpoch: row.started_at_epoch,
    completedAtEpoch: row.completed_at_epoch ?? null,
    updatedAtEpoch: row.updated_at_epoch
  })
}

export class HelixServerSessionsRepository {
  constructor(private readonly transport: HelixTransport) {}

  async create(input: CreateServerSession): Promise<ServerSession> {
    const session = CreateServerSessionSchema.parse(input)
    const now = Date.now()
    const row = await this.transport.insertNode('ServerSession', {
      id: randomUUID(),
      project_id: session.projectId,
      content_session_id: session.contentSessionId ?? null,
      memory_session_id: session.memorySessionId ?? null,
      platform_source: session.platformSource ?? 'claude',
      title: session.title ?? null,
      status: 'active',
      metadata: stringifyJson(session.metadata),
      started_at_epoch: now,
      completed_at_epoch: null,
      updated_at_epoch: now
    })
    return mapServerSessionRow(row)
  }

  async markCompleted(id: string, completedAtEpoch = Date.now()): Promise<ServerSession | null> {
    const rows = await this.transport.updateNodes('ServerSession', { id }, {
      status: 'completed',
      completed_at_epoch: completedAtEpoch,
      updated_at_epoch: completedAtEpoch
    })
    return rows[0] ? mapServerSessionRow(rows[0]) : null
  }

  async getById(id: string): Promise<ServerSession | null> {
    const rows = await this.transport.findNodes('ServerSession', { id })
    return rows[0] ? mapServerSessionRow(rows[0]) : null
  }

  async listByProject(projectId: string): Promise<ServerSession[]> {
    const rows = await this.transport.findNodes('ServerSession', { project_id: projectId })
    return rows
      .map(mapServerSessionRow)
      .sort((left, right) => right.startedAtEpoch - left.startedAtEpoch)
  }
}

