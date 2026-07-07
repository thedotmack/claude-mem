import { randomUUID } from 'crypto'
import {
  ApiKeySchema,
  AuditLogSchema,
  CreateApiKeySchema,
  CreateAuditLogSchema,
  type ApiKey,
  type AuditLog,
  type CreateApiKey,
  type CreateAuditLog
} from '../../core/schemas/auth.js'
import { parseJsonArray, parseJsonObject, stringifyJson } from '../sqlite/serde.js'
import type { HelixNode, HelixTransport } from './transport.js'

function mapApiKeyRow(row: HelixNode): ApiKey {
  return ApiKeySchema.parse({
    id: row.id,
    teamId: row.team_id ?? null,
    projectId: row.project_id ?? null,
    name: row.name,
    keyHash: row.key_hash,
    prefix: row.prefix ?? null,
    scopes: parseJsonArray(typeof row.scopes === 'string' ? row.scopes : '[]'),
    status: row.status ?? 'active',
    lastUsedAtEpoch: row.last_used_at_epoch ?? null,
    expiresAtEpoch: row.expires_at_epoch ?? null,
    metadata: parseJsonObject(typeof row.metadata === 'string' ? row.metadata : '{}'),
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  })
}

function mapAuditLogRow(row: HelixNode): AuditLog {
  return AuditLogSchema.parse({
    id: row.id,
    teamId: row.team_id ?? null,
    projectId: row.project_id ?? null,
    actorType: row.actor_type,
    actorId: row.actor_id ?? null,
    action: row.action,
    targetType: row.target_type ?? null,
    targetId: row.target_id ?? null,
    metadata: parseJsonObject(typeof row.metadata === 'string' ? row.metadata : '{}'),
    createdAtEpoch: row.created_at_epoch
  })
}

export class HelixAuthRepository {
  constructor(private readonly transport: HelixTransport) {}

  async createApiKey(input: CreateApiKey): Promise<ApiKey> {
    const key = CreateApiKeySchema.parse(input)
    const existing = await this.transport.findNodes('ApiKey', { key_hash: key.keyHash })
    if (existing.length > 0) {
      throw new Error('API key hash already exists')
    }
    const now = Date.now()
    const row = await this.transport.insertNode('ApiKey', {
      id: randomUUID(),
      team_id: key.teamId ?? null,
      project_id: key.projectId ?? null,
      name: key.name,
      key_hash: key.keyHash,
      prefix: key.prefix ?? null,
      scopes: stringifyJson(key.scopes ?? []),
      status: 'active',
      last_used_at_epoch: null,
      expires_at_epoch: key.expiresAtEpoch ?? null,
      metadata: stringifyJson(key.metadata),
      created_at_epoch: now,
      updated_at_epoch: now
    })
    return mapApiKeyRow(row)
  }

  async revokeApiKey(id: string, updatedAtEpoch = Date.now()): Promise<ApiKey | null> {
    const rows = await this.transport.updateNodes('ApiKey', { id }, {
      status: 'revoked',
      updated_at_epoch: updatedAtEpoch
    })
    return rows[0] ? mapApiKeyRow(rows[0]) : null
  }

  async markApiKeyUsed(id: string, usedAtEpoch = Date.now()): Promise<ApiKey | null> {
    const rows = await this.transport.updateNodes('ApiKey', { id }, {
      last_used_at_epoch: usedAtEpoch,
      updated_at_epoch: usedAtEpoch
    })
    return rows[0] ? mapApiKeyRow(rows[0]) : null
  }

  async createAuditLog(input: CreateAuditLog): Promise<AuditLog> {
    const log = CreateAuditLogSchema.parse(input)
    const row = await this.transport.insertNode('AuditLog', {
      id: randomUUID(),
      team_id: log.teamId ?? null,
      project_id: log.projectId ?? null,
      actor_type: log.actorType,
      actor_id: log.actorId ?? null,
      action: log.action,
      target_type: log.targetType ?? null,
      target_id: log.targetId ?? null,
      metadata: stringifyJson(log.metadata),
      created_at_epoch: Date.now()
    })
    return mapAuditLogRow(row)
  }

  async getApiKeyById(id: string): Promise<ApiKey | null> {
    const rows = await this.transport.findNodes('ApiKey', { id })
    return rows[0] ? mapApiKeyRow(rows[0]) : null
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const rows = await this.transport.findNodes('ApiKey', { key_hash: keyHash })
    return rows[0] ? mapApiKeyRow(rows[0]) : null
  }

  async listActiveApiKeysByPrefix(prefix: string): Promise<ApiKey[]> {
    const rows = await this.transport.findNodes('ApiKey', {
      prefix,
      status: 'active'
    })
    return rows
      .map(mapApiKeyRow)
      .sort((left, right) => right.createdAtEpoch - left.createdAtEpoch)
  }

  async updateApiKeyHash(id: string, keyHash: string, updatedAtEpoch = Date.now()): Promise<ApiKey | null> {
    const rows = await this.transport.updateNodes('ApiKey', { id }, {
      key_hash: keyHash,
      updated_at_epoch: updatedAtEpoch
    })
    return rows[0] ? mapApiKeyRow(rows[0]) : null
  }

  async updateApiKeyScopes(id: string, scopes: string[], updatedAtEpoch = Date.now()): Promise<ApiKey | null> {
    const rows = await this.transport.updateNodes('ApiKey', { id }, {
      scopes: stringifyJson(scopes),
      updated_at_epoch: updatedAtEpoch
    })
    return rows[0] ? mapApiKeyRow(rows[0]) : null
  }

  async listApiKeys(limit = 100): Promise<ApiKey[]> {
    const rows = await this.transport.findNodes('ApiKey')
    return rows
      .map(mapApiKeyRow)
      .sort((left, right) => right.createdAtEpoch - left.createdAtEpoch)
      .slice(0, limit)
  }

  async getAuditLogById(id: string): Promise<AuditLog | null> {
    const rows = await this.transport.findNodes('AuditLog', { id })
    return rows[0] ? mapAuditLogRow(rows[0]) : null
  }

  async listAuditLogByProject(projectId: string, limit = 100): Promise<AuditLog[]> {
    const rows = await this.transport.findNodes('AuditLog', { project_id: projectId })
    return rows
      .map(mapAuditLogRow)
      .sort((left, right) => right.createdAtEpoch - left.createdAtEpoch)
      .slice(0, limit)
  }
}

