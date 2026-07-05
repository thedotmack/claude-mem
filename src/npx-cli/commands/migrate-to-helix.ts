import { Database } from 'bun:sqlite'
import { styleText } from 'node:util'
import { DB_PATH } from '../../shared/paths.js'
import { ProjectsRepository, ServerSessionsRepository, AgentEventsRepository, MemoryItemsRepository, AuthRepository } from '../../storage/sqlite/index.js'
import { HelixManager } from '../../services/sync/HelixManager.js'
import {
  HelixAgentEventsRepository,
  HelixAuthRepository,
  HelixMemoryItemsRepository,
  HelixProjectsRepository,
  HelixServerSessionsRepository
} from '../../storage/helix/index.js'

export async function runMigrateToHelixCommand(): Promise<void> {
  const db = new Database(DB_PATH, { readonly: true })
  const manager = new HelixManager()
  const transport = await manager.getTransport()
  const sqliteProjects = new ProjectsRepository(db)
  const sqliteSessions = new ServerSessionsRepository(db)
  const sqliteEvents = new AgentEventsRepository(db)
  const sqliteMemories = new MemoryItemsRepository(db)
  const sqliteAuth = new AuthRepository(db)
  const helixProjects = new HelixProjectsRepository(transport)
  const helixSessions = new HelixServerSessionsRepository(transport)
  const helixEvents = new HelixAgentEventsRepository(transport)
  const helixMemories = new HelixMemoryItemsRepository(transport)
  const helixAuth = new HelixAuthRepository(transport)

  let projectsCopied = 0
  let sessionsCopied = 0
  let eventsCopied = 0
  let memoriesCopied = 0
  let auditCopied = 0

  const projects = sqliteProjects.list()
  for (const project of projects) {
    const created = await helixProjects.create({
      name: project.name,
      slug: project.slug,
      rootPath: project.rootPath,
      metadata: project.metadata
    })
    const sessions = sqliteSessions.listByProject(project.id)
    projectsCopied++
    for (const session of sessions) {
      const next = await helixSessions.create({
        projectId: created.id,
        contentSessionId: session.contentSessionId,
        memorySessionId: session.memorySessionId,
        platformSource: session.platformSource,
        title: session.title,
        metadata: session.metadata
      })
      sessionsCopied++
      if (session.status === 'completed') {
        await helixSessions.markCompleted(next.id, session.completedAtEpoch ?? session.updatedAtEpoch)
      }
    }
    const events = sqliteEvents.listByProject(project.id)
    for (const event of events) {
      await helixEvents.create({
        projectId: created.id,
        serverSessionId: null,
        sourceType: event.sourceType,
        eventType: event.eventType,
        payload: event.payload,
        contentSessionId: event.contentSessionId,
        memorySessionId: event.memorySessionId,
        occurredAtEpoch: event.occurredAtEpoch,
        platformSource: event.platformSource
      })
      eventsCopied++
    }
    const memories = sqliteMemories.listByProject(project.id, 10_000)
    for (const memory of memories) {
      await helixMemories.create({
        projectId: created.id,
        serverSessionId: null,
        legacyObservationId: memory.legacyObservationId,
        kind: memory.kind,
        type: memory.type,
        title: memory.title,
        subtitle: memory.subtitle,
        text: memory.text,
        narrative: memory.narrative,
        facts: memory.facts,
        concepts: memory.concepts,
        filesRead: memory.filesRead,
        filesModified: memory.filesModified,
        metadata: memory.metadata
      })
      memoriesCopied++
    }
    const audit = sqliteAuth.listAuditLogByProject(project.id, 10_000)
    for (const entry of audit) {
      await helixAuth.createAuditLog({
        teamId: entry.teamId,
        projectId: created.id,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata
      })
      auditCopied++
    }
  }

  db.close()
  console.log(styleText('green', `Migrated ${projectsCopied} project(s), ${sessionsCopied} session(s), ${eventsCopied} event(s), ${memoriesCopied} memory item(s), ${auditCopied} audit row(s) to Helix.`))
}
