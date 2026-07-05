// SPDX-License-Identifier: Apache-2.0

import type { Application, Request, Response } from 'express'
import type { Database } from 'bun:sqlite'
import { z, type ZodTypeAny } from 'zod'
import type { RouteHandler } from '../../../services/server/Server.js'
import { CreateAgentEventSchema } from '../../../core/schemas/agent-event.js'
import { CreateMemoryItemSchema } from '../../../core/schemas/memory-item.js'
import { CreateProjectSchema } from '../../../core/schemas/project.js'
import { CreateServerSessionSchema } from '../../../core/schemas/session.js'
import { LocalStorageFactory } from '../../../storage/LocalStorageFactory.js'
import { requireServerAuth } from '../../middleware/auth.js'
import type { HelixTransport } from '../../../storage/helix/transport.js'

declare const __DEFAULT_PACKAGE_VERSION__: string
const BUILT_IN_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
  ? __DEFAULT_PACKAGE_VERSION__
  : 'development'

function hasSearchableContent(body: {
  title?: string | null;
  subtitle?: string | null;
  text?: string | null;
  narrative?: string | null;
  facts?: string[];
  concepts?: string[];
}): boolean {
  const hasText = (value: string | null | undefined): boolean =>
    typeof value === 'string' && value.trim().length > 0
  return (
    hasText(body.title) ||
    hasText(body.subtitle) ||
    hasText(body.text) ||
    hasText(body.narrative) ||
    (Array.isArray(body.facts) && body.facts.some(hasText)) ||
    (Array.isArray(body.concepts) && body.concepts.some(hasText))
  )
}

export interface ServerV1RoutesOptions {
  getDatabase: () => Database;
  getHelixTransport?: () => Promise<HelixTransport>;
  backend?: string;
  authMode?: string;
  runtime?: string;
  allowLocalDevBypass?: boolean;
}

export class ServerV1Routes implements RouteHandler {
  private readonly storageFactory: LocalStorageFactory

  constructor(private readonly options: ServerV1RoutesOptions) {
    this.storageFactory = new LocalStorageFactory({
      getDatabase: options.getDatabase,
      backend: options.backend,
      getHelixTransport: options.getHelixTransport
    })
  }

  setupRoutes(app: Application): void {
    const readAuth = requireServerAuth(this.options.getDatabase, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:read'],
    })
    const writeAuth = requireServerAuth(this.options.getDatabase, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:write'],
    })

    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok', backend: this.storageFactory.getBackend() })
    })

    app.get('/v1/info', (_req, res) => {
      res.json({
        name: 'claude-mem-server',
        version: BUILT_IN_VERSION,
        ...(this.options.runtime ? { runtime: this.options.runtime } : {}),
        authMode: this.options.authMode ?? process.env.CLAUDE_MEM_AUTH_MODE ?? 'api-key',
        storageBackend: this.storageFactory.getBackend(),
      })
    })

    app.get('/v1/projects', readAuth, async (req, res) => {
      const repo = await this.storageFactory.projects()
      const projects = req.authContext?.projectId
        ? [await repo.getById(req.authContext.projectId)].filter(project => project !== null)
        : await repo.list()
      res.json({ projects })
      await this.audit(req, 'projects.list')
    })

    app.post('/v1/projects', writeAuth, this.handleCreate(CreateProjectSchema, async (req, res, body) => {
      if (req.authContext?.projectId) {
        res.status(403).json({ error: 'Forbidden', message: 'Project-scoped API keys cannot create projects' })
        return
      }
      const project = await (await this.storageFactory.projects()).create(body)
      await this.audit(req, 'project.create', project.id)
      res.status(201).json({ project })
    }))

    app.get('/v1/projects/:id', readAuth, async (req, res) => {
      const id = this.routeParam(req.params.id)
      if (!this.ensureProjectAllowed(req, res, id)) return
      const project = await (await this.storageFactory.projects()).getById(id)
      if (!project) {
        res.status(404).json({ error: 'NotFound', message: 'Project not found' })
        return
      }
      await this.audit(req, 'project.read', project.id)
      res.json({ project })
    })

    app.post('/v1/sessions/start', writeAuth, this.handleCreate(CreateServerSessionSchema, async (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return
      const session = await (await this.storageFactory.sessions()).create(body)
      await this.audit(req, 'session.start', session.id, session.projectId)
      res.status(201).json({ session })
    }))

    app.post('/v1/sessions/:id/end', writeAuth, async (req, res) => {
      const id = this.routeParam(req.params.id)
      const repo = await this.storageFactory.sessions()
      const existing = await repo.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' })
        return
      }
      if (!this.ensureProjectAllowed(req, res, existing.projectId)) return
      const session = await repo.markCompleted(id)
      await this.audit(req, 'session.end', id, existing.projectId)
      res.json({ session })
    })

    app.get('/v1/sessions/:id', readAuth, async (req, res) => {
      const id = this.routeParam(req.params.id)
      const session = await (await this.storageFactory.sessions()).getById(id)
      if (!session) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' })
        return
      }
      if (!this.ensureProjectAllowed(req, res, session.projectId)) return
      await this.audit(req, 'session.read', session.id, session.projectId)
      res.json({ session })
    })

    app.post('/v1/events', writeAuth, this.handleCreate(CreateAgentEventSchema, async (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return
      const event = await (await this.storageFactory.agentEvents()).create(body)
      await this.audit(req, 'event.write', event.id, event.projectId)
      res.status(201).json({ event })
    }))

    app.post('/v1/events/batch', writeAuth, this.handleCreate(z.array(CreateAgentEventSchema).min(1).max(500), async (req, res, body) => {
      for (const event of body) {
        if (!this.ensureProjectAllowed(req, res, event.projectId)) return
      }
      const repo = await this.storageFactory.agentEvents()
      const events = await Promise.all(body.map(event => repo.create(event)))
      await this.audit(req, 'event.batch_write')
      res.status(201).json({ events })
    }))

    app.get('/v1/events/:id', readAuth, async (req, res) => {
      const id = this.routeParam(req.params.id)
      const event = await (await this.storageFactory.agentEvents()).getById(id)
      if (!event) {
        res.status(404).json({ error: 'NotFound', message: 'Event not found' })
        return
      }
      if (!this.ensureProjectAllowed(req, res, event.projectId)) return
      await this.audit(req, 'event.read', event.id, event.projectId)
      res.json({ event })
    })

    app.post('/v1/memories', writeAuth, this.handleCreate(CreateMemoryItemSchema, async (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return
      if (!hasSearchableContent(body)) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'memory_items requires at least one searchable text field (narrative, text, title, subtitle, facts, or concepts) so the FTS index is populated; refusing to persist an empty record',
        })
        return
      }
      const memory = await (await this.storageFactory.memoryItems()).create(body)
      await this.audit(req, 'memory.write', memory.id, memory.projectId)
      res.status(201).json({ memory })
    }))

    app.get('/v1/memories/:id', readAuth, async (req, res) => {
      const id = this.routeParam(req.params.id)
      const memory = await (await this.storageFactory.memoryItems()).getById(id)
      if (!memory) {
        res.status(404).json({ error: 'NotFound', message: 'Memory not found' })
        return
      }
      if (!this.ensureProjectAllowed(req, res, memory.projectId)) return
      await this.audit(req, 'memory.read', memory.id, memory.projectId)
      res.json({ memory })
    })

    app.patch('/v1/memories/:id', writeAuth, this.handleCreate(CreateMemoryItemSchema.partial(), async (req, res, body) => {
      const id = this.routeParam(req.params.id)
      const repo = await this.storageFactory.memoryItems()
      const existing = await repo.getById(id)
      if (!existing) {
        res.status(404).json({ error: 'NotFound', message: 'Memory not found' })
        return
      }
      if (!this.ensureProjectAllowed(req, res, existing.projectId)) return
      if (body.projectId && body.projectId !== existing.projectId) {
        res.status(400).json({ error: 'ValidationError', message: 'projectId cannot be changed' })
        return
      }
      const memory = await repo.update(id, body)
      await this.audit(req, 'memory.update', id, existing.projectId)
      res.json({ memory })
    }))

    app.post('/v1/search', readAuth, this.handleCreate(z.object({
      projectId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
    }), async (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return
      const memories = await (await this.storageFactory.memoryItems()).search(body.projectId, body.query, body.limit ?? 20)
      await this.audit(req, 'memory.search', null, body.projectId)
      res.json({ memories })
    }))

    app.post('/v1/context', readAuth, this.handleCreate(z.object({
      projectId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
    }), async (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return
      const memories = await (await this.storageFactory.memoryItems()).search(body.projectId, body.query, body.limit ?? 10)
      await this.audit(req, 'memory.context', null, body.projectId)
      res.json({ memories, context: memories.map(memory => memory.narrative ?? memory.text ?? memory.title).filter(Boolean).join('\n\n') })
    }))

    app.get('/v1/audit', readAuth, async (req, res) => {
      const projectId = String(req.query.projectId ?? '')
      if (!projectId) {
        res.status(400).json({ error: 'ValidationError', message: 'projectId query parameter is required' })
        return
      }
      if (!this.ensureProjectAllowed(req, res, projectId)) return
      res.json({ audit: await (await this.storageFactory.auth()).listAuditLogByProject(projectId) })
    })
  }

  private handleCreate<S extends ZodTypeAny, T = z.infer<S>>(
    schema: S,
    handler: (req: Request, res: Response, body: T) => Promise<void>,
  ) {
    return async (req: Request, res: Response) => {
      const result = schema.safeParse(req.body)
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues })
        return
      }
      await handler(req, res, result.data as T)
    }
  }

  private ensureProjectAllowed(req: Request, res: Response, projectId: string): boolean {
    if (req.authContext?.projectId && req.authContext.projectId !== projectId) {
      res.status(403).json({ error: 'Forbidden', message: 'API key is scoped to a different project' })
      return false
    }
    return true
  }

  private routeParam(value: string | string[]): string {
    return Array.isArray(value) ? value[0] ?? '' : value
  }

  private async audit(req: Request, action: string, targetId: string | null = null, projectId: string | null = null): Promise<void> {
    await (await this.storageFactory.auth()).createAuditLog({
      teamId: req.authContext?.teamId ?? null,
      projectId: projectId ?? req.authContext?.projectId ?? null,
      actorType: req.authContext?.apiKeyId ? 'api_key' : 'system',
      actorId: req.authContext?.apiKeyId ?? null,
      action,
      targetType: targetId ? action.split('.')[0] : null,
      targetId,
    })
  }
}
