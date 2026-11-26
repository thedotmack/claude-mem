import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { saveMemory } from '../../../memory/save-memory.js';
import { logger } from '../../../../utils/logger.js';
import { getProjectContext, isAbsoluteFilesystemPath, normalizeExplicitProject } from '../../../../utils/project-name.js';
import { isProjectExcluded } from '../../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import type { MemorySaveRefusalReason } from '../../../../shared/memory-save-refusal.js';

const saveMemorySchema = z.object({
  text: z.string().trim().min(1),
  title: z.string().optional(),
  project: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().optional(),
}).strict();

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', validateBody(saveMemorySchema), this.handleSaveMemory.bind(this));
  }

  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // An explicit save writes a user-visible memory observation, so other
    // localhost pages may not trigger it. Origin-less clients (the MCP
    // save_memory tool, Hermes, grok-bot) keep the existing loopback-trust model.
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Memory saves from a different localhost origin are not allowed' });
      return;
    }
    const { cwd, ...input } = req.body as z.infer<typeof saveMemorySchema>;
    const checkout = cwd?.trim() ? cwd : undefined;
    // Loaded even without cwd: an excluded checkout named as an absolute
    // project path must still be refused.
    const excluded = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS
      ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_EXCLUDED_PROJECTS;
    if (checkout && isProjectExcluded(checkout, excluded)) {
      res.json({ success: false, skipped: true, reason: 'project_excluded' satisfies MemorySaveRefusalReason });
      return;
    }
    const rawProject = input.project?.trim() || (typeof input.metadata?.project === 'string' ? input.metadata.project.trim() : '');
    if (rawProject && isAbsoluteFilesystemPath(rawProject)) {
      if (isProjectExcluded(rawProject, excluded)) {
        res.json({ success: false, skipped: true, reason: 'project_excluded' satisfies MemorySaveRefusalReason });
        return;
      }
      // An absolute path names a checkout, not a project: reduce it so the save
      // cannot create an orphan project keyed by the path.
      const normalized = normalizeExplicitProject(rawProject);
      input.project = normalized;
      // Only rewrite a metadata project that is itself a path: a plain string
      // there is the caller's own label and must survive normalization.
      if (typeof input.metadata?.project === 'string' && isAbsoluteFilesystemPath(input.metadata.project)) {
        input.metadata = { ...input.metadata, project: normalized };
      }
    } else if (checkout && !rawProject) {
      input.project = getProjectContext(checkout).primary;
    }
    const result = saveMemory(this.dbManager, this.defaultProject, input);
    logger.debug('HTTP', 'Explicit memory request completed', { id: result.id });
    res.json(result);
  });
}
