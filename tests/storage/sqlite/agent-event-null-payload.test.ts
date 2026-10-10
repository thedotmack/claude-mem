import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProjectsRepository } from '../../../src/storage/sqlite/projects.js';
import { AgentEventsRepository } from '../../../src/storage/sqlite/agent-events.js';
import { buildAgentEventIdempotencyKey } from '../../../src/storage/postgres/agent-events.js';

it('round-trips explicit JSON null in a raw event payload', () => {
  const db = new Database(':memory:');
  try {
    const project = new ProjectsRepository(db).create({ name: 'project' });
    const repo = new AgentEventsRepository(db);
    const event = repo.create({ projectId: project.id, sourceType: 'api', eventType: 'changed', payload: null, occurredAtEpoch: 100 });
    expect(event.payload).toBeNull();
    expect(repo.getById(event.id)?.payload).toBeNull();
    expect(repo.create({ projectId: project.id, sourceType: 'api', eventType: 'changed', occurredAtEpoch: 100 }).payload).toEqual({});
  } finally { db.close(); }
});
it('distinguishes null and empty-object event bodies in PostgreSQL replay identity', () => {
  const input = { projectId: 'project', teamId: 'team', sourceAdapter: 'api', eventType: 'changed', occurredAt: 100 };
  expect(buildAgentEventIdempotencyKey({ ...input, payload: null })).not.toBe(buildAgentEventIdempotencyKey({ ...input, payload: {} }));
  expect(buildAgentEventIdempotencyKey(input)).toBe(buildAgentEventIdempotencyKey({ ...input, payload: {} }));
});
