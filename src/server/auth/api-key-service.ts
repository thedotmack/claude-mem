// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from 'crypto';
import { Database } from 'bun:sqlite';
import { AuthRepository, ensureServerStorageSchema } from '../../storage/sqlite/index.js';
import type { ApiKey } from '../../core/schemas/auth.js';

export interface CreatedServerApiKey {
  rawKey: string;
  record: ApiKey;
}

export interface VerifiedServerApiKey {
  record: ApiKey;
  teamId: string | null;
  projectId: string | null;
  scopes: string[];
}

export interface CreateServerApiKeyInput {
  name: string;
  teamId?: string | null;
  projectId?: string | null;
  scopes?: string[];
  expiresAtEpoch?: number | null;
  metadata?: Record<string, unknown>;
}

export function hashServerApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function createRawServerApiKey(): string {
  return `cmem_${randomBytes(32).toString('base64url')}`;
}

export function createServerApiKey(db: Database, input: CreateServerApiKeyInput): CreatedServerApiKey {
  ensureServerStorageSchema(db);
  const rawKey = createRawServerApiKey();
  const repo = new AuthRepository(db);
  const record = repo.createApiKey({
    name: input.name,
    teamId: input.teamId ?? null,
    projectId: input.projectId ?? null,
    keyHash: hashServerApiKey(rawKey),
    prefix: rawKey.slice(0, 10),
    scopes: input.scopes ?? [],
    expiresAtEpoch: input.expiresAtEpoch ?? null,
    metadata: input.metadata ?? {},
  });

  repo.createAuditLog({
    teamId: record.teamId,
    projectId: record.projectId,
    actorType: 'system',
    action: 'api_key.create',
    targetType: 'api_key',
    targetId: record.id,
  });

  return { rawKey, record };
}

export function verifyServerApiKey(
  db: Database,
  rawKey: string,
  requiredScopes: string[] = [],
): VerifiedServerApiKey | null {
  ensureServerStorageSchema(db);
  const repo = new AuthRepository(db);
  const record = repo.getApiKeyByHash(hashServerApiKey(rawKey));
  if (!record || record.status !== 'active') {
    return null;
  }
  if (record.expiresAtEpoch !== null && record.expiresAtEpoch <= Date.now()) {
    return null;
  }
  if (!hasRequiredScopes(record.scopes, requiredScopes)) {
    return null;
  }

  repo.markApiKeyUsed(record.id);
  return {
    record,
    teamId: record.teamId,
    projectId: record.projectId,
    scopes: record.scopes,
  };
}

export function listServerApiKeys(db: Database): ApiKey[] {
  ensureServerStorageSchema(db);
  return new AuthRepository(db).listApiKeys();
}

export function revokeServerApiKey(db: Database, id: string): ApiKey | null {
  ensureServerStorageSchema(db);
  const repo = new AuthRepository(db);
  const record = repo.revokeApiKey(id);
  if (record) {
    repo.createAuditLog({
      teamId: record.teamId,
      projectId: record.projectId,
      actorType: 'system',
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: record.id,
    });
  }
  return record;
}

function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0 || grantedScopes.includes('*')) {
    return true;
  }
  return requiredScopes.every(scope => grantedScopes.includes(scope));
}
