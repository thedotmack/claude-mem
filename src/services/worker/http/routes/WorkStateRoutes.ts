import express, { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { isProjectExcluded } from '../../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { logger } from '../../../../utils/logger.js';
import { renderWorkStateLines } from '../../../context/sections/WorkStateRenderer.js';

/** One write is a few short fields; anything bigger would crowd the SessionStart section. */
export const MAX_WORK_STATE_FIELDS_JSON_CHARS = 2_000;

const workStateWriteSchema = z.object({
  cwd: z.string().trim().min(1),
  list: z.string().trim().min(1).max(200),
  fields: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .refine(fields => Object.keys(fields).length > 0, 'fields must set at least one key')
    .refine(
      fields => JSON.stringify(fields).length <= MAX_WORK_STATE_FIELDS_JSON_CHARS,
      `fields must be at most ${MAX_WORK_STATE_FIELDS_JSON_CHARS} characters as JSON`,
    ),
});

/**
 * Surface for `work_state_entries`, the agent's canonical to-do lists and
 * working state, called by the work_state_write / work_state_read MCP tools with
 * the session's cwd. A write lands under the checkout's primary project key; a
 * read covers every key the checkout reads (worktree parent included), the same
 * scope SessionStart shows. Both answer in plain text for the agent.
 */
export class WorkStateRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/work-state/entries', validateBody(workStateWriteSchema), this.handleWrite.bind(this));
    app.get('/api/work-state', this.handleRead.bind(this));
  }

  private handleWrite = this.wrapHandler((req: Request, res: Response): void => {
    const { cwd, list, fields } = req.body as z.infer<typeof workStateWriteSchema>;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('WORKER', 'Work state write skipped for an excluded project', { cwd, list });
      res.send('Not saved: this project is excluded from claude-mem (CLAUDE_MEM_EXCLUDED_PROJECTS).');
      return;
    }

    const checkout = getProjectContext(cwd);
    const store = this.dbManager.getSessionStore();
    store.appendWorkStateEntry({ project: checkout.primary, listName: list, fields });
    logger.debug('WORKER', 'Work state entry saved', { project: checkout.primary, list });
    const listLines = renderWorkStateLines(store.getWorkStateEntries(checkout.allProjects, list), Date.now(), true);
    res.send(`Saved to "${list}" in ${checkout.primary}. The list now reads:\n${listLines.join('\n')}`);
  });

  private handleRead = this.wrapHandler((req: Request, res: Response): void => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd.trim() : '';
    if (!cwd) {
      this.badRequest(res, 'cwd is required');
      return;
    }
    const list = typeof req.query.list === 'string' && req.query.list.trim() ? req.query.list.trim() : undefined;
    const includeClosed = req.query.includeClosed === 'true';

    const checkout = getProjectContext(cwd);
    const entries = this.dbManager.getSessionStore().getWorkStateEntries(checkout.allProjects, list);
    const lines = renderWorkStateLines(entries, Date.now(), includeClosed);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (lines.length > 0) {
      res.send(lines.join('\n'));
    } else if (includeClosed) {
      res.send(`Nothing recorded${list ? ` in "${list}"` : ''} for ${checkout.primary}.`);
    } else {
      res.send(`Nothing open${list ? ` in "${list}"` : ''} for ${checkout.primary}. Pass includeClosed to see closed items.`);
    }
  });
}
