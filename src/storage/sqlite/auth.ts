// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import {
  ApiKeySchema,
  AuditLogSchema,
  CreateApiKeySchema,
  CreateAuditLogSchema,
  type ApiKey,
  type ApiKeyStatus,
  type AuditActorType,
  type AuditLog,
  type CreateApiKey,
  type CreateAuditLog
} from '../../core/schemas/auth.js';
import { ensureServerStorageSchema } from './schema.js';
import { parseJsonArray, parseJsonObject, stringifyJson } from './serde.js';

interface ApiKeyRow {
  id: string;
  team_id: string | null;
  project_id: string | null;
  name: string;
  key_hash: string;
  prefix: string | null;
  scopes: string;
  status: ApiKeyStatus;
  last_used_at_epoch: number | null;
  expires_at_epoch: number | null;
  metadata: string;
  created_at_epoch: number;
  updated_at_epoch: number;
}

interface AuditLogRow {
  id: string;
  team_id: string | null;
  project_id: string | null;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: string;
  created_at_epoch: number;
}

function mapApiKeyRow(row: ApiKeyRow): ApiKey {
  return ApiKeySchema.parse({
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    name: row.name,
    keyHash: row.key_hash,
    prefix: row.prefix,
    scopes: parseJsonArray(row.scopes),
    status: row.status,
    lastUsedAtEpoch: row.last_used_at_epoch,
    expiresAtEpoch: row.expires_at_epoch,
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  });
}

function mapAuditLogRow(row: AuditLogRow): AuditLog {
  return AuditLogSchema.parse({
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch
  });
}

export class AuthRepository {
  constructor(private db: Database) {
    ensureServerStorageSchema(this.db);
  }

  createApiKey(input: CreateApiKey): ApiKey {
    const key = CreateApiKeySchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO api_keys (
        id, team_id, project_id, name, key_hash, prefix, scopes, status,
        last_used_at_epoch, expires_at_epoch, metadata, created_at_epoch, updated_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)
    `).run(
      id,
      key.teamId ?? null,
      key.projectId ?? null,
      key.name,
      key.keyHash,
      key.prefix ?? null,
      stringifyJson(key.scopes ?? []),
      key.expiresAtEpoch ?? null,
      stringifyJson(key.metadata),
      now,
      now
    );

    return this.getApiKeyById(id)!;
  }

  revokeApiKey(id: string, updatedAtEpoch = Date.now()): ApiKey | null {
    this.db.prepare(`
      UPDATE api_keys
      SET status = 'revoked', updated_at_epoch = ?
      WHERE id = ?
    `).run(updatedAtEpoch, id);

    return this.getApiKeyById(id);
  }

  markApiKeyUsed(id: string, usedAtEpoch = Date.now()): ApiKey | null {
    this.db.prepare(`
      UPDATE api_keys
      SET last_used_at_epoch = ?, updated_at_epoch = ?
      WHERE id = ?
    `).run(usedAtEpoch, usedAtEpoch, id);

    return this.getApiKeyById(id);
  }

  createAuditLog(input: CreateAuditLog): AuditLog {
    const log = CreateAuditLogSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO audit_log (
        id, team_id, project_id, actor_type, actor_id, action, target_type,
        target_id, metadata, created_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      log.teamId ?? null,
      log.projectId ?? null,
      log.actorType,
      log.actorId ?? null,
      log.action,
      log.targetType ?? null,
      log.targetId ?? null,
      stringifyJson(log.metadata),
      now
    );

    return this.getAuditLogById(id)!;
  }

  getApiKeyById(id: string): ApiKey | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | null;
    return row ? mapApiKeyRow(row) : null;
  }

  getApiKeyByHash(keyHash: string): ApiKey | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash) as ApiKeyRow | null;
    return row ? mapApiKeyRow(row) : null;
  }

  listApiKeys(limit = 100): ApiKey[] {
    const rows = this.db.prepare(`
      SELECT * FROM api_keys
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(limit) as ApiKeyRow[];
    return rows.map(mapApiKeyRow);
  }

  getAuditLogById(id: string): AuditLog | null {
    const row = this.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as AuditLogRow | null;
    return row ? mapAuditLogRow(row) : null;
  }

  listAuditLogByProject(projectId: string, limit = 100): AuditLog[] {
    const rows = this.db.prepare(`
      SELECT * FROM audit_log
      WHERE project_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(projectId, limit) as AuditLogRow[];
    return rows.map(mapAuditLogRow);
  }
}
