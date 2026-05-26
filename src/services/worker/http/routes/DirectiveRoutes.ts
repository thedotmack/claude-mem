
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

const addDirectiveSchema = z.object({
  content: z.string().trim().min(1),
  scope: z.enum(['global', 'project']).default('global'),
  project: z.string().optional(),
}).strict();

const archiveDirectiveSchema = z.object({
  id: z.number().int(),
}).strict();

const DEFAULT_DIRECTIVE_LIMIT = 100;

export class DirectiveRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/directive/add', validateBody(addDirectiveSchema), this.handleAddDirective.bind(this));
    app.get('/api/directive/list', this.handleListDirectives.bind(this));
    app.post('/api/directive/archive', validateBody(archiveDirectiveSchema), this.handleArchiveDirective.bind(this));
  }

  private handleAddDirective = this.wrapHandler((req: Request, res: Response): void => {
    const { content, scope, project } = req.body as z.infer<typeof addDirectiveSchema>;

    if (scope === 'project' && !(typeof project === 'string' && project.trim())) {
      this.badRequest(res, 'project is required when scope is "project"');
      return;
    }

    const resolvedProject = scope === 'project' ? project!.trim() : null;
    const { id } = this.dbManager.getSessionStore().addDirective(content, scope, resolvedProject);

    logger.info('HTTP', 'Standing directive saved', { id, scope, project: resolvedProject });

    res.json({ success: true, id, content, scope, project: resolvedProject });
  });

  private handleListDirectives = this.wrapHandler((req: Request, res: Response): void => {
    const projectsParam = req.query.projects as string | undefined;
    const projects = projectsParam
      ? projectsParam.split(',').map(p => p.trim()).filter(Boolean)
      : [];

    const directives = this.dbManager.getSessionStore().listActiveDirectives(projects, DEFAULT_DIRECTIVE_LIMIT);

    res.json({ directives });
  });

  private handleArchiveDirective = this.wrapHandler((req: Request, res: Response): void => {
    const { id } = req.body as z.infer<typeof archiveDirectiveSchema>;

    const archived = this.dbManager.getSessionStore().archiveDirective(id);
    if (!archived) {
      this.badRequest(res, `Directive ${id} not found`);
      return;
    }

    logger.info('HTTP', 'Standing directive archived', { id });

    res.json({ success: true, id: archived.id });
  });
}
