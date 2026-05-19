// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { assertProjectOwnership, newId, queryOne, toDate, toEpoch, toJsonArray, toJsonObject } from './utils.js';

export interface PostgresApiKey {
  id: string;
  keyHash: string;
  teamId: string | null;
  projectId: string | null;
  actorId: string;
  scopes: unknown[];
  revokedAtEpoch: number | null;
  expiresAtEpoch: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface PostgresAuditLog {
  id: string;
  teamId: string | null;
  projectId: string | null;
  actorId: string | null;
  apiKeyId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: JsonObject;
  createdAtEpoch: number;
}

interface ApiKeyRow {
  id: string;
  key_hash: string;
  team_id: string | null;
  project_id: string | null;
  actor_id: string;
  scopes: unknown;
  revoked_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AuditLogRow {
  id: string;
  team_id: string | null;
  project_id: string | null;
  actor_id: string | null;
  api_key_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: unknown;
  created_at: Date;
}

export class PostgresAuthRepository {
  constructor(private client: PostgresQueryable) {}

  async createApiKey(input: {
    id?: string;
    keyHash: string;
    teamId?: string | null;
    projectId?: string | null;
    actorId: string;
    scopes?: unknown[];
    expiresAt?: Date | null;
  }): Promise<PostgresApiKey> {
    if (input.projectId && input.teamId) {
      await assertProjectOwnership(this.client, input.projectId, input.teamId);
    }
    const id = input.id ?? newId();
    const row = await queryOne<ApiKeyRow>(
      this.client,
      `
        INSERT INTO api_keys (id, key_hash, team_id, project_id, actor_id, scopes, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        RETURNING *
      `,
      [
        id,
        input.keyHash,
        input.teamId ?? null,
        input.projectId ?? null,
        input.actorId,
        JSON.stringify(input.scopes ?? []),
        input.expiresAt ?? null
      ]
    );
    return mapApiKeyRow(row!);
  }

  async createAuditLog(input: {
    id?: string;
    teamId?: string | null;
    projectId?: string | null;
    actorId?: string | null;
    apiKeyId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    details?: JsonObject;
  }): Promise<PostgresAuditLog> {
    if (input.projectId && input.teamId) {
      await assertProjectOwnership(this.client, input.projectId, input.teamId);
    }
    const id = input.id ?? newId();
    const row = await queryOne<AuditLogRow>(
      this.client,
      `
        INSERT INTO audit_log (
          id, team_id, project_id, actor_id, api_key_id, action,
          resource_type, resource_id, details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        RETURNING *
      `,
      [
        id,
        input.teamId ?? null,
        input.projectId ?? null,
        input.actorId ?? null,
        input.apiKeyId ?? null,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        JSON.stringify(input.details ?? {})
      ]
    );
    return mapAuditLogRow(row!);
  }

  async getApiKeyByHash(keyHash: string): Promise<PostgresApiKey | null> {
    const row = await queryOne<ApiKeyRow>(this.client, 'SELECT * FROM api_keys WHERE key_hash = $1', [keyHash]);
    return row ? mapApiKeyRow(row) : null;
  }

  async getApiKeyById(id: string): Promise<PostgresApiKey | null> {
    const row = await queryOne<ApiKeyRow>(
      this.client,
      'SELECT * FROM api_keys WHERE id = $1',
      [id],
    );
    return row ? mapApiKeyRow(row) : null;
  }

  // fix — list and revoke helpers used by the CLI when
  // CLAUDE_MEM_RUNTIME=server-beta. Pre-fix the CLI routed through the
  // worker SQLite path which is invisible to the Postgres-backed server.
  async listApiKeys(input: {
    teamId?: string | null;
    limit?: number;
    offset?: number;
  } = {}): Promise<PostgresApiKey[]> {
    const teamFilter = input.teamId ?? null;
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const where = teamFilter ? 'WHERE team_id = $1' : '';
    const params: unknown[] = teamFilter
      ? [teamFilter, limit, offset]
      : [limit, offset];
    const limitIdx = teamFilter ? 2 : 1;
    const offsetIdx = teamFilter ? 3 : 2;
    const result = await this.client.query<ApiKeyRow>(
      `SELECT * FROM api_keys
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return result.rows.map(row => mapApiKeyRow(row));
  }

  // Revoke by id; returns the updated row, or null if no live key matched.
  // Already-revoked rows are a no-op (return null) so the caller can detect
  // double-revoke attempts and surface a clear error.
  async revokeApiKey(id: string): Promise<PostgresApiKey | null> {
    const result = await this.client.query<ApiKeyRow>(
      `UPDATE api_keys
       SET revoked_at = now(), updated_at = now()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING *`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapApiKeyRow(row) : null;
  }
}

function mapApiKeyRow(row: ApiKeyRow): PostgresApiKey {
  return {
    id: row.id,
    keyHash: row.key_hash,
    teamId: row.team_id,
    projectId: row.project_id,
    actorId: row.actor_id,
    scopes: toJsonArray(row.scopes),
    revokedAtEpoch: toDate(row.revoked_at)?.getTime() ?? null,
    expiresAtEpoch: toDate(row.expires_at)?.getTime() ?? null,
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}

function mapAuditLogRow(row: AuditLogRow): PostgresAuditLog {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    actorId: row.actor_id,
    apiKeyId: row.api_key_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    details: toJsonObject(row.details),
    createdAtEpoch: toEpoch(row.created_at)
  };
}
