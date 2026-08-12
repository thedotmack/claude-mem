import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  AuthRepository,
  SERVER_OWNED_TABLES,
  ensureServerStorageSchema,
  parseJsonArray,
  parseJsonObject
} from '../../../src/storage/sqlite/index.js';

interface TableNameRow {
  name: string;
}

function withDb(fn: (db: Database) => void): void {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe('server-owned sqlite storage boundary', () => {
  it('creates every server-owned table idempotently', () => {
    withDb(db => {
      ensureServerStorageSchema(db);
      ensureServerStorageSchema(db);

      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as TableNameRow[];
      const tables = rows.map(row => row.name);

      for (const table of SERVER_OWNED_TABLES) {
        expect(tables).toContain(table);
      }
    });
  });

  it('round-trips api-key and audit-log records using JSON-as-TEXT fields', () => {
    withDb(db => {
      const auth = new AuthRepository(db);

      const key = auth.createApiKey({
        teamId: 'team-core',
        projectId: 'project-1',
        name: 'placeholder',
        keyHash: 'hash-1',
        scopes: ['memory:read']
      });
      const audit = auth.createAuditLog({
        teamId: 'team-core',
        projectId: 'project-1',
        actorType: 'api_key',
        actorId: key.id,
        action: 'memory.read'
      });

      expect(key.scopes).toEqual(['memory:read']);
      expect(audit.action).toBe('memory.read');
      expect(auth.listAuditLogByProject('project-1').map(entry => entry.id)).toContain(audit.id);
    });
  });

  it('does not require legacy worker tables to use server-owned repositories', () => {
    withDb(db => {
      const auth = new AuthRepository(db);
      const key = auth.createApiKey({ name: 'Server only', keyHash: 'hash-2' });

      expect(key.name).toBe('Server only');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'").get()).toBeNull();
    });
  });

  it('degrades malformed JSON fields to empty values', () => {
    expect(parseJsonObject('{not-json')).toEqual({});
    expect(parseJsonArray('{not-json')).toEqual([]);
  });
});
