import { describe, expect, it } from 'bun:test'
import {
  HelixAgentEventsRepository,
  HelixAuthRepository,
  HelixMemoryItemsRepository,
  HelixProjectsRepository,
  HelixServerSessionsRepository,
  InMemoryHelixTransport
} from '../../../src/storage/helix/index.js'

describe('server-owned helix storage boundary', () => {
  it('round-trips project, session, event, memory, source, and audit records', async () => {
    const transport = new InMemoryHelixTransport()
    const projects = new HelixProjectsRepository(transport)
    const sessions = new HelixServerSessionsRepository(transport)
    const events = new HelixAgentEventsRepository(transport)
    const memories = new HelixMemoryItemsRepository(transport)
    const auth = new HelixAuthRepository(transport)

    const project = await projects.create({
      name: 'Claude Mem',
      rootPath: '/tmp/claude-mem',
      metadata: { source: 'test' }
    })
    const session = await sessions.create({
      projectId: project.id,
      memorySessionId: 'memory-1'
    })
    const event = await events.create({
      projectId: project.id,
      serverSessionId: session.id,
      sourceType: 'hook',
      eventType: 'observation.created',
      payload: { type: 'learned' },
      occurredAtEpoch: Date.now()
    })
    const memory = await memories.create({
      projectId: project.id,
      serverSessionId: session.id,
      legacyObservationId: 42,
      kind: 'observation',
      type: 'learned',
      title: 'Storage boundary',
      facts: ['JSON text is decoded'],
      metadata: { legacyTable: 'observations' }
    })
    const source = await memories.addSource({
      memoryItemId: memory.id,
      sourceType: 'observation',
      legacyTable: 'observations',
      legacyId: 42
    })
    const key = await auth.createApiKey({
      teamId: 'team-core',
      projectId: project.id,
      name: 'placeholder',
      keyHash: 'hash-1',
      scopes: ['memory:read']
    })
    const audit = await auth.createAuditLog({
      teamId: 'team-core',
      projectId: project.id,
      actorType: 'api_key',
      actorId: key.id,
      action: 'memory.read'
    })

    expect(project.metadata.source).toBe('test')
    expect(session.memorySessionId).toBe('memory-1')
    expect(event.payload).toEqual({ type: 'learned' })
    expect(memory.facts).toEqual(['JSON text is decoded'])
    expect(source.legacyTable).toBe('observations')
    expect(key.scopes).toEqual(['memory:read'])
    expect(audit.action).toBe('memory.read')
  })

  it('rejects duplicate legacy observation backfill rows and supports ranked search', async () => {
    const transport = new InMemoryHelixTransport()
    const projects = new HelixProjectsRepository(transport)
    const memories = new HelixMemoryItemsRepository(transport)
    const project = await projects.create({ name: 'Legacy Backfill' })

    const first = await memories.create({
      projectId: project.id,
      legacyObservationId: 42,
      kind: 'observation',
      type: 'learned',
      text: 'BullMQ queues require Redis or Valkey'
    })
    await expect(memories.create({
      projectId: project.id,
      legacyObservationId: 42,
      kind: 'observation',
      type: 'learned',
      text: 'duplicate'
    })).rejects.toThrow()

    const search = await memories.search(project.id, 'Valkey')
    expect(search.map(item => item.id)).toContain(first.id)
  })
})

