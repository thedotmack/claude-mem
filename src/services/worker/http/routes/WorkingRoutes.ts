
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import {
  appendJournal,
  closeTask,
  DEFAULT_TASK_KEY,
  dropEntry,
  estimateTokens,
  listEntries,
  promoteEntry,
  setEntry,
  WorkingLimitError,
  WorkingNotFoundError,
  workingLimitsFromSettings,
  type WorkingLimits,
} from '../../../working/store.js';

const putSchema = z.object({
  project: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1),
  value: z.string().min(1),
}).strict();

const deleteSchema = z.object({
  project: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1),
}).strict();

const journalSchema = z.object({
  project: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1),
}).strict();

const promoteSchema = z.object({
  project: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1),
  type: z.enum(['decision', 'discovery']).optional(),
}).strict();

const closeSchema = z.object({
  project: z.string().trim().min(1),
  task: z.string().trim().min(1).optional(),
}).strict();

type LoadSettings = () => SettingsDefaults;

export class WorkingRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private loadSettings: LoadSettings = () => SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH),
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/working', this.handleList.bind(this));
    app.put('/api/working', validateBody(putSchema), this.handleSet.bind(this));
    app.delete('/api/working', validateBody(deleteSchema), this.handleDrop.bind(this));
    app.post('/api/working/journal', validateBody(journalSchema), this.handleJournal.bind(this));
    app.post('/api/working/promote', validateBody(promoteSchema), this.handlePromote.bind(this));
    app.post('/api/working/close', validateBody(closeSchema), this.handleClose.bind(this));
  }

  /**
   * Master flag check + limits resolution in one place. Returns null (after
   * answering 403) when the feature is off — MCP callers surface the error
   * text, hooks never reach this route when disabled.
   */
  private limitsOrDisabled(res: Response): WorkingLimits | null {
    const settings = this.loadSettings();
    if (String(settings.CLAUDE_MEM_WORKING_ENABLED).toLowerCase() !== 'true') {
      res.status(403).json({ error: 'WORKING_DISABLED', message: 'working memory is disabled (CLAUDE_MEM_WORKING_ENABLED=false)' });
      return null;
    }
    return workingLimitsFromSettings(settings);
  }

  private handleLimitError(res: Response, error: WorkingLimitError): void {
    res.status(409).json({ error: error.code, message: error.message, keys: error.keys });
  }

  private handleList = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limits = this.limitsOrDisabled(res);
    if (!limits) return;

    const project = this.toStringParam(req.query.project as string | string[] | undefined);
    if (!project) {
      this.badRequest(res, 'project query parameter is required');
      return;
    }
    const taskParam = this.toStringParam(req.query.task as string | string[] | undefined);
    const taskKey = taskParam || undefined;

    const db = this.dbManager.getSessionStore().db;
    const entries = listEntries(db, project, taskKey);
    res.json({
      project,
      task_key: taskKey ?? null,
      entries,
      tokens: estimateTokens(entries),
      limits,
    });
  });

  private handleSet = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limits = this.limitsOrDisabled(res);
    if (!limits) return;

    const { project, task, key, value } = req.body as z.infer<typeof putSchema>;
    const db = this.dbManager.getSessionStore().db;
    try {
      const entry = setEntry(db, project, task ?? DEFAULT_TASK_KEY, key, value, limits);
      res.json({ success: true, entry });
    } catch (error) {
      if (error instanceof WorkingLimitError) {
        this.handleLimitError(res, error);
        return;
      }
      throw error;
    }
  });

  private handleDrop = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limits = this.limitsOrDisabled(res);
    if (!limits) return;

    const { project, task, key } = req.body as z.infer<typeof deleteSchema>;
    const db = this.dbManager.getSessionStore().db;
    try {
      dropEntry(db, project, task ?? DEFAULT_TASK_KEY, key);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof WorkingNotFoundError) {
        this.notFound(res, error.message);
        return;
      }
      throw error;
    }
  });

  private handleJournal = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limits = this.limitsOrDisabled(res);
    if (!limits) return;

    const { project, task, text } = req.body as z.infer<typeof journalSchema>;
    const db = this.dbManager.getSessionStore().db;
    appendJournal(db, project, task ?? DEFAULT_TASK_KEY, text, limits);
    res.json({ success: true });
  });

  private handlePromote = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limits = this.limitsOrDisabled(res);
    if (!limits) return;

    const { project, task, key, type } = req.body as z.infer<typeof promoteSchema>;
    const store = this.dbManager.getSessionStore();
    try {
      const result = promoteEntry(store, project, task ?? DEFAULT_TASK_KEY, key, type ?? 'decision');
      logger.info('HTTP', 'Working-memory entry promoted to observation', { project, task: task ?? DEFAULT_TASK_KEY, key, observationId: result.observationId });
      this.dbManager.getCloudSync()?.notify();
      res.json({ success: true, observationId: result.observationId });
    } catch (error) {
      if (error instanceof WorkingNotFoundError) {
        this.notFound(res, error.message);
        return;
      }
      throw error;
    }
  });

  private handleClose = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limits = this.limitsOrDisabled(res);
    if (!limits) return;

    const { project, task } = req.body as z.infer<typeof closeSchema>;
    const db = this.dbManager.getSessionStore().db;
    const dropped = closeTask(db, project, task ?? DEFAULT_TASK_KEY);
    res.json({ success: true, dropped });
  });
}
