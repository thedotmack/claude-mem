import { describe, expect, it } from 'bun:test';
import {
  AgentEventSchema,
  ApiKeySchema,
  ContextPackSchema,
  MemoryItemSchema,
  ProjectSchema,
  ServerSessionSchema,
  TeamSchema
} from '../../../src/core/schemas/index.js';

describe('server storage Zod schemas', () => {
  it('parses the shared contracts used by server-owned tables', () => {
    const now = Date.now();
    const project = ProjectSchema.parse({
      id: 'project-1',
      name: 'Claude Mem',
      createdAtEpoch: now,
      updatedAtEpoch: now
    });

    const session = ServerSessionSchema.parse({
      id: 'session-1',
      projectId: project.id,
      startedAtEpoch: now,
      updatedAtEpoch: now
    });

    const memoryItem = MemoryItemSchema.parse({
      id: 'memory-1',
      projectId: project.id,
      serverSessionId: session.id,
      kind: 'observation',
      type: 'learned',
      createdAtEpoch: now,
      updatedAtEpoch: now
    });

    const event = AgentEventSchema.parse({
      id: 'event-1',
      projectId: project.id,
      sourceType: 'hook',
      eventType: 'observation.created',
      occurredAtEpoch: now,
      createdAtEpoch: now
    });

    const team = TeamSchema.parse({
      id: 'team-1',
      name: 'Team',
      createdAtEpoch: now,
      updatedAtEpoch: now
    });

    const apiKey = ApiKeySchema.parse({
      id: 'key-1',
      name: 'Local key',
      keyHash: 'hash',
      createdAtEpoch: now,
      updatedAtEpoch: now
    });

    const contextPack = ContextPackSchema.parse({
      projectId: project.id,
      generatedAtEpoch: now,
      items: [memoryItem]
    });

    expect(project.metadata).toEqual({});
    expect(session.platformSource).toBe('claude');
    expect(memoryItem.facts).toEqual([]);
    expect(event.payload).toEqual({});
    expect(team.metadata).toEqual({});
    expect(apiKey.status).toBe('active');
    expect(contextPack.items).toHaveLength(1);
  });

  it('rejects invalid enum values at the contract boundary', () => {
    expect(() => MemoryItemSchema.parse({
      id: 'memory-1',
      projectId: 'project-1',
      kind: 'legacy',
      type: 'learned',
      createdAtEpoch: Date.now(),
      updatedAtEpoch: Date.now()
    })).toThrow();
  });
});
