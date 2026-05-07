import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  AgentEventsRepository,
  AuthRepository,
  MemoryItemsRepository,
  ProjectsRepository,
  SERVER_OWNED_TABLES,
  ServerSessionsRepository,
  TeamsRepository,
  ensureServerStorageSchema
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

  it('round-trips repository records using JSON-as-TEXT fields', () => {
    withDb(db => {
      const projects = new ProjectsRepository(db);
      const sessions = new ServerSessionsRepository(db);
      const events = new AgentEventsRepository(db);
      const memories = new MemoryItemsRepository(db);
      const teams = new TeamsRepository(db);
      const auth = new AuthRepository(db);

      const project = projects.create({
        name: 'Claude Mem',
        rootPath: '/tmp/claude-mem',
        metadata: { source: 'test' }
      });
      const session = sessions.create({
        projectId: project.id,
        memorySessionId: 'memory-1'
      });
      const event = events.create({
        projectId: project.id,
        serverSessionId: session.id,
        sourceType: 'hook',
        eventType: 'observation.created',
        payload: { type: 'learned' },
        occurredAtEpoch: Date.now()
      });
      const memory = memories.create({
        projectId: project.id,
        serverSessionId: session.id,
        legacyObservationId: 42,
        kind: 'observation',
        type: 'learned',
        title: 'Storage boundary',
        facts: ['JSON text is decoded'],
        metadata: { legacyTable: 'observations' }
      });
      const source = memories.addSource({
        memoryItemId: memory.id,
        sourceType: 'observation',
        legacyTable: 'observations',
        legacyId: 42
      });
      const team = teams.create({ name: 'Core' });
      const member = teams.addMember({ teamId: team.id, userId: 'user-1', role: 'owner' });
      const key = auth.createApiKey({
        teamId: team.id,
        projectId: project.id,
        name: 'placeholder',
        keyHash: 'hash-1',
        scopes: ['memory:read']
      });
      const audit = auth.createAuditLog({
        teamId: team.id,
        projectId: project.id,
        actorType: 'api_key',
        actorId: key.id,
        action: 'memory.read'
      });

      expect(project.metadata.source).toBe('test');
      expect(session.memorySessionId).toBe('memory-1');
      expect(event.payload).toEqual({ type: 'learned' });
      expect(memory.facts).toEqual(['JSON text is decoded']);
      expect(source.legacyTable).toBe('observations');
      expect(member.role).toBe('owner');
      expect(key.scopes).toEqual(['memory:read']);
      expect(audit.action).toBe('memory.read');
    });
  });

  it('does not require legacy worker tables to use server-owned repositories', () => {
    withDb(db => {
      const projects = new ProjectsRepository(db);
      const project = projects.create({ name: 'Server only' });

      expect(project.name).toBe('Server only');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'").get()).toBeNull();
    });
  });

  it('prevents duplicate legacy observation backfill rows', () => {
    withDb(db => {
      const projects = new ProjectsRepository(db);
      const memories = new MemoryItemsRepository(db);
      const project = projects.create({ name: 'Legacy Backfill' });

      const first = memories.create({
        projectId: project.id,
        legacyObservationId: 42,
        kind: 'observation',
        type: 'learned',
      });

      expect(first.legacyObservationId).toBe(42);
      expect(() => memories.create({
        projectId: project.id,
        legacyObservationId: 42,
        kind: 'observation',
        type: 'learned',
      })).toThrow();

      memories.addSource({
        memoryItemId: first.id,
        sourceType: 'observation',
        legacyTable: 'observations',
        legacyId: 42,
      });

      expect(() => memories.addSource({
        memoryItemId: first.id,
        sourceType: 'observation',
        legacyTable: 'observations',
        legacyId: 42,
      })).toThrow();
    });
  });

  it('rejects server-session links across project boundaries', () => {
    withDb(db => {
      const projects = new ProjectsRepository(db);
      const sessions = new ServerSessionsRepository(db);
      const events = new AgentEventsRepository(db);
      const memories = new MemoryItemsRepository(db);

      const projectA = projects.create({ name: 'Project A' });
      const projectB = projects.create({ name: 'Project B' });
      const sessionA = sessions.create({ projectId: projectA.id });

      expect(() => events.create({
        projectId: projectB.id,
        serverSessionId: sessionA.id,
        sourceType: 'hook',
        eventType: 'observation.created',
        occurredAtEpoch: Date.now(),
      })).toThrow(/server_session_id must belong to project_id/);

      expect(() => memories.create({
        projectId: projectB.id,
        serverSessionId: sessionA.id,
        kind: 'manual',
        type: 'note',
      })).toThrow(/server_session_id must belong to project_id/);
    });
  });
});
