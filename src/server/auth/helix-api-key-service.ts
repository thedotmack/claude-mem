// SPDX-License-Identifier: Apache-2.0

import type { HelixAuthRepository } from '../../storage/helix/auth.js';
import type { ApiKey } from '../../core/schemas/auth.js';
import { verifyRawKeyAgainstStoredHash, hashServerApiKey } from './sqlite-api-key-service.js';

export interface VerifiedHelixServerApiKey {
  record: ApiKey;
  teamId: string | null;
  projectId: string | null;
  scopes: string[];
}

function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0 || grantedScopes.includes('*')) {
    return true;
  }
  return requiredScopes.every(scope => grantedScopes.includes(scope));
}

/**
 * Helix-backed analogue of verifyServerApiKey: narrow candidates by the
 * non-secret key prefix, verify the presented key against each stored hash,
 * then enforce expiry and scopes. Mirrors the SQLite service so the two
 * backends accept the same keys with the same semantics (#3145 P1).
 */
export async function verifyHelixServerApiKey(
  repo: HelixAuthRepository,
  rawKey: string,
  requiredScopes: string[] = [],
): Promise<VerifiedHelixServerApiKey | null> {
  const candidates = await repo.listActiveApiKeysByPrefix(rawKey.slice(0, 10));
  let record: ApiKey | null = null;
  for (const candidate of candidates) {
    if (verifyRawKeyAgainstStoredHash(rawKey, candidate.keyHash)) {
      record = candidate;
      break;
    }
  }
  if (!record) {
    return null;
  }
  if (record.expiresAtEpoch !== null && record.expiresAtEpoch <= Date.now()) {
    return null;
  }
  if (!hasRequiredScopes(record.scopes, requiredScopes)) {
    return null;
  }

  // Transparently upgrade a legacy-hashed key now that we hold the plaintext,
  // matching the SQLite service's behavior.
  if (!record.keyHash.startsWith('scrypt$')) {
    await repo.updateApiKeyHash(record.id, hashServerApiKey(rawKey));
  }

  await repo.markApiKeyUsed(record.id);
  return {
    record,
    teamId: record.teamId,
    projectId: record.projectId,
    scopes: record.scopes,
  };
}
