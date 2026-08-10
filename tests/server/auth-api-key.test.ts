import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createServerApiKey,
  createRawServerApiKey,
  hashServerApiKey,
  hashServerApiKeyLegacySha256,
  verifyRawKeyAgainstStoredHash,
  migrateServerApiKeyScopes,
  revokeServerApiKey,
  verifyServerApiKey,
  DEFAULT_LOCAL_API_KEY_SCOPES,
} from '../../src/server/auth/sqlite-api-key-service.js';
import { AuthRepository } from '../../src/storage/sqlite/index.js';

describe('server API key auth', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('creates raw keys once while storing only a salted hash', () => {
    const created = createServerApiKey(db, {
      name: 'Team key',
      teamId: null,
      projectId: null,
      scopes: ['memories:read'],
    });

    expect(created.rawKey).toStartWith('cmem_');
    // #2541 — stored hash is salted scrypt (non-deterministic per raw key),
    // never the plaintext, and verifiable via the constant-time verifier.
    expect(created.record.keyHash).toStartWith('scrypt$');
    expect(created.record.keyHash).not.toContain(created.rawKey);
    expect(verifyRawKeyAgainstStoredHash(created.rawKey, created.record.keyHash)).toBe(true);
    // Salt makes two hashes of the same input differ.
    expect(hashServerApiKey(created.rawKey)).not.toBe(hashServerApiKey(created.rawKey));
    expect(created.record.prefix).toBe(created.rawKey.slice(0, 10));
  });

  it('verifies a key created with the salted scheme', () => {
    const created = createServerApiKey(db, { name: 'k', scopes: ['memories:read'] });
    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])?.record.id).toBe(created.record.id);
    expect(verifyServerApiKey(db, 'cmem_wrong-key', ['memories:read'])).toBeNull();
  });

  it('still verifies legacy unsalted SHA-256 keys (#2541 backward compat)', () => {
    // Seed a key the OLD way: unsalted SHA-256 hash written directly.
    const rawKey = createRawServerApiKey();
    const legacyHash = hashServerApiKeyLegacySha256(rawKey);
    const repo = new AuthRepository(db);
    const record = repo.createApiKey({
      name: 'legacy',
      keyHash: legacyHash,
      prefix: rawKey.slice(0, 10),
      scopes: ['memories:read'],
    });
    expect(record.keyHash).toBe(legacyHash);

    // Legacy key still authenticates.
    const verified = verifyServerApiKey(db, rawKey, ['memories:read']);
    expect(verified?.record.id).toBe(record.id);

    // After verify, the stored hash is transparently upgraded to salted scrypt.
    const upgraded = new AuthRepository(db).getApiKeyById(record.id);
    expect(upgraded?.keyHash).toStartWith('scrypt$');
    // And it still verifies under the new scheme.
    expect(verifyServerApiKey(db, rawKey, ['memories:read'])?.record.id).toBe(record.id);
  });

  it('defaults new keys to read+write scopes (#2428)', () => {
    const created = createServerApiKey(db, { name: 'default-scope-key' });
    expect(created.record.scopes).toEqual([...DEFAULT_LOCAL_API_KEY_SCOPES]);
    // A default key is authorized for both read and write scopes.
    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])).not.toBeNull();
    expect(verifyServerApiKey(db, created.rawKey, ['memories:write'])).not.toBeNull();
    // But NOT for a scope it was never granted.
    expect(verifyServerApiKey(db, created.rawKey, ['admin:all'])).toBeNull();
  });

  it('migrates a legacy key with empty scopes up to working defaults (#2560)', () => {
    const rawKey = createRawServerApiKey();
    const repo = new AuthRepository(db);
    const record = repo.createApiKey({
      name: 'empty-scope',
      keyHash: hashServerApiKeyLegacySha256(rawKey),
      prefix: rawKey.slice(0, 10),
      scopes: [],
    });
    // Empty-scope key cannot access read scopes.
    expect(verifyServerApiKey(db, rawKey, ['memories:read'])).toBeNull();

    const migrated = migrateServerApiKeyScopes(db, record.id);
    expect(migrated?.scopes).toEqual([...DEFAULT_LOCAL_API_KEY_SCOPES]);
    // Now it works.
    expect(verifyServerApiKey(db, rawKey, ['memories:read'])).not.toBeNull();
    expect(verifyServerApiKey(db, rawKey, ['memories:write'])).not.toBeNull();
  });

  it('verifies required scopes and rejects revoked keys', () => {
    const created = createServerApiKey(db, {
      name: 'Scoped key',
      scopes: ['memories:read'],
    });

    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])?.record.id).toBe(created.record.id);
    expect(verifyServerApiKey(db, created.rawKey, ['memories:write'])).toBeNull();

    revokeServerApiKey(db, created.record.id);
    expect(verifyServerApiKey(db, created.rawKey, ['memories:read'])).toBeNull();
  });

  it('carries teamId and projectId through to the verified record', () => {
    const created = createServerApiKey(db, {
      name: 'Scoped to team+project',
      teamId: 'team-core',
      projectId: 'project-1',
      scopes: ['memories:write'],
    });

    const verified = verifyServerApiKey(db, created.rawKey, ['memories:write']);
    expect(verified?.teamId).toBe('team-core');
    expect(verified?.projectId).toBe('project-1');
    expect(verified?.scopes).toEqual(['memories:write']);
  });
});
