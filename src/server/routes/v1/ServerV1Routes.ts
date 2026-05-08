// SPDX-License-Identifier: Apache-2.0

import type { Application, Request, Response } from 'express';
import type { Database } from 'bun:sqlite';
import { z, type ZodTypeAny } from 'zod';
import type { RouteHandler } from '../../../services/server/Server.js';
import { CreateAgentEventSchema } from '../../../core/schemas/agent-event.js';
import { CreateMemoryItemSchema } from '../../../core/schemas/memory-item.js';
import { CreateProjectSchema } from '../../../core/schemas/project.js';
import { CreateServerSessionSchema } from '../../../core/schemas/session.js';
import {
  AgentEventsRepository,
  AuthRepository,
  MemoryItemsRepository,
  ProjectsRepository,
  ServerSessionsRepository,
} from '../../../storage/sqlite/index.js';
import { requireServerAuth } from '../../middleware/auth.js';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const BUILT_IN_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
  ? __DEFAULT_PACKAGE_VERSION__
  : 'development';

export interface ServerV1RoutesOptions {
  getDatabase: () => Database;
  authMode?: string;
  runtime?: string;
  allowLocalDevBypass?: boolean;
}

export class ServerV1Routes implements RouteHandler {
  constructor(private readonly options: ServerV1RoutesOptions) {}

  setupRoutes(app: Application): void {
    const readAuth = requireServerAuth(this.options.getDatabase, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:read'],
    });
    const writeAuth = requireServerAuth(this.options.getDatabase, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:write'],
    });

    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok' });
    });

    app.get('/v1/info', (_req, res) => {
      res.json({
        name: 'claude-mem-server',
        version: BUILT_IN_VERSION,
        ...(this.options.runtime ? { runtime: this.options.runtime } : {}),
        authMode: this.options.authMode ?? process.env.CLAUDE_MEM_AUTH_MODE ?? 'api-key',
      });
    });

    app.get('/v1/projects', readAuth, (req, res) => {
      const repo = new ProjectsRepository(this.options.getDatabase());
      const projects = req.authContext?.projectId
        ? [repo.getById(req.authContext.projectId)].filter(project => project !== null)
        : repo.list();
      res.json({ projects });
      this.audit(req, 'projects.list');
    });

    app.post('/v1/projects', writeAuth, this.handleCreate(CreateProjectSchema, (req, res, body) => {
      if (req.authContext?.projectId) {
        res.status(403).json({ error: 'Forbidden', message: 'Project-scoped API keys cannot create projects' });
        return;
      }
      const project = new ProjectsRepository(this.options.getDatabase()).create(body);
      this.audit(req, 'project.create', project.id);
      res.status(201).json({ project });
    }));

    app.get('/v1/projects/:id', readAuth, (req, res) => {
      const id = this.routeParam(req.params.id);
      if (!this.ensureProjectAllowed(req, res, id)) return;
      const project = new ProjectsRepository(this.options.getDatabase()).getById(id);
      if (!project) {
        res.status(404).json({ error: 'NotFound', message: 'Project not found' });
        return;
      }
      this.audit(req, 'project.read', project.id);
      res.json({ project });
    });

    app.post('/v1/sessions/start', writeAuth, this.handleCreate(CreateServerSessionSchema, (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
      const session = new ServerSessionsRepository(this.options.getDatabase()).create(body);
      this.audit(req, 'session.start', session.id, session.projectId);
      res.status(201).json({ session });
    }));

    app.post('/v1/sessions/:id/end', writeAuth, (req, res) => {
      const id = this.routeParam(req.params.id);
      const repo = new ServerSessionsRepository(this.options.getDatabase());
      const existing = repo.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, existing.projectId)) return;
      const session = repo.markCompleted(id);
      this.audit(req, 'session.end', id, existing.projectId);
      res.json({ session });
    });

    app.get('/v1/sessions/:id', readAuth, (req, res) => {
      const id = this.routeParam(req.params.id);
      const session = new ServerSessionsRepository(this.options.getDatabase()).getById(id);
      if (!session) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, session.projectId)) return;
      this.audit(req, 'session.read', session.id, session.projectId);
      res.json({ session });
    });

    app.post('/v1/events', writeAuth, this.handleCreate(CreateAgentEventSchema, (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
      const event = new AgentEventsRepository(this.options.getDatabase()).create(body);
      this.audit(req, 'event.write', event.id, event.projectId);
      res.status(201).json({ event });
    }));

    app.post('/v1/events/batch', writeAuth, this.handleCreate(z.array(CreateAgentEventSchema).min(1).max(500), (req, res, body) => {
      for (const event of body) {
        if (!this.ensureProjectAllowed(req, res, event.projectId)) return;
      }
      const db = this.options.getDatabase();
      const repo = new AgentEventsRepository(db);
      const insertEvents = db.transaction((eventsToCreate: typeof body) => {
        return eventsToCreate.map(event => repo.create(event));
      });
      const events = insertEvents(body);
      this.audit(req, 'event.batch_write');
      res.status(201).json({ events });
    }));

    app.get('/v1/events/:id', readAuth, (req, res) => {
      const id = this.routeParam(req.params.id);
      const event = new AgentEventsRepository(this.options.getDatabase()).getById(id);
      if (!event) {
        res.status(404).json({ error: 'NotFound', message: 'Event not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, event.projectId)) return;
      this.audit(req, 'event.read', event.id, event.projectId);
      res.json({ event });
    });

    app.post('/v1/memories', writeAuth, this.handleCreate(CreateMemoryItemSchema, (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
      const memory = new MemoryItemsRepository(this.options.getDatabase()).create(body);
      this.audit(req, 'memory.write', memory.id, memory.projectId);
      res.status(201).json({ memory });
    }));

    app.get('/v1/memories/:id', readAuth, (req, res) => {
      const id = this.routeParam(req.params.id);
      const memory = new MemoryItemsRepository(this.options.getDatabase()).getById(id);
      if (!memory) {
        res.status(404).json({ error: 'NotFound', message: 'Memory not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, memory.projectId)) return;
      this.audit(req, 'memory.read', memory.id, memory.projectId);
      res.json({ memory });
    });

    app.patch('/v1/memories/:id', writeAuth, this.handleCreate(CreateMemoryItemSchema.partial(), (req, res, body) => {
      const id = this.routeParam(req.params.id);
      const repo = new MemoryItemsRepository(this.options.getDatabase());
      const existing = repo.getById(id);
      if (!existing) {
        res.status(404).json({ error: 'NotFound', message: 'Memory not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, existing.projectId)) return;
      if (body.projectId && body.projectId !== existing.projectId) {
        res.status(400).json({ error: 'ValidationError', message: 'projectId cannot be changed' });
        return;
      }
      const memory = repo.update(id, body);
      this.audit(req, 'memory.update', id, existing.projectId);
      res.json({ memory });
    }));

    app.post('/v1/search', readAuth, this.handleCreate(z.object({
      projectId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
    }), (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
      const memories = new MemoryItemsRepository(this.options.getDatabase()).search(body.projectId, body.query, body.limit ?? 20);
      this.audit(req, 'memory.search', null, body.projectId);
      res.json({ memories });
    }));

    app.post('/v1/context', readAuth, this.handleCreate(z.object({
      projectId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).optional(),
    }), (req, res, body) => {
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
      const memories = new MemoryItemsRepository(this.options.getDatabase()).search(body.projectId, body.query, body.limit ?? 10);
      this.audit(req, 'memory.context', null, body.projectId);
      res.json({ memories, context: memories.map(memory => memory.narrative ?? memory.text ?? memory.title).filter(Boolean).join('\n\n') });
    }));

    app.get('/v1/audit', readAuth, (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) {
        res.status(400).json({ error: 'ValidationError', message: 'projectId query parameter is required' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, projectId)) return;
      res.json({ audit: new AuthRepository(this.options.getDatabase()).listAuditLogByProject(projectId) });
    });
  }

  private handleCreate<S extends ZodTypeAny, T = z.infer<S>>(
    schema: S,
    handler: (req: Request, res: Response, body: T) => void,
  ) {
    return (req: Request, res: Response) => {
      const result = schema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues });
        return;
      }
      handler(req, res, result.data as T);
    };
  }

  private ensureProjectAllowed(req: Request, res: Response, projectId: string): boolean {
    if (req.authContext?.projectId && req.authContext.projectId !== projectId) {
      res.status(403).json({ error: 'Forbidden', message: 'API key is scoped to a different project' });
      return false;
    }
    return true;
  }

  private routeParam(value: string | string[]): string {
    return Array.isArray(value) ? value[0] ?? '' : value;
  }

  private audit(req: Request, action: string, targetId: string | null = null, projectId: string | null = null): void {
    new AuthRepository(this.options.getDatabase()).createAuditLog({
      teamId: req.authContext?.teamId ?? null,
      projectId: projectId ?? req.authContext?.projectId ?? null,
      actorType: req.authContext?.apiKeyId ? 'api_key' : 'system',
      actorId: req.authContext?.apiKeyId ?? null,
      action,
      targetType: targetId ? action.split('.')[0] : null,
      targetId,
    });
  }
}
