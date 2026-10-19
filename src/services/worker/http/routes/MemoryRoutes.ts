import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { saveMemory } from '../../../memory/save-memory.js';
import { logger } from '../../../../utils/logger.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { isProjectExcluded } from '../../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';

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
    const { cwd, ...input } = req.body as z.infer<typeof saveMemorySchema>;
    const checkout = cwd?.trim();
    if (checkout) {
      const excluded = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS
        ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_EXCLUDED_PROJECTS;
      if (isProjectExcluded(checkout, excluded)) {
        res.json({ success: false, skipped: true, reason: 'project_excluded' });
        return;
      }
      const named = input.project?.trim() || (typeof input.metadata?.project === 'string' && input.metadata.project.trim());
      if (!named) input.project = getProjectContext(checkout).primary;
    }
    const result = saveMemory(this.dbManager, this.defaultProject, input);
    logger.debug('HTTP', 'Explicit memory request completed', { id: result.id });
    res.json(result);
  });
}
