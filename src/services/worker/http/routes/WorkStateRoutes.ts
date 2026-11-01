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
import type { WorkStateFields } from '../../../sqlite/work-state.js';
import { isMyRulesList } from '../../../work-view/my-rules.mjs';
import { isMyFocusList } from '../../../work-view/my-focus.mjs';
import { GOAL_KINDS, isOwnerGoalsList } from '../../../work-view/owner-goals.mjs';
import { MAX_WORK_STATE_FIELDS_JSON_CHARS } from '../../../work-view/work-state-limits.mjs';
import {
  fitWorkStateLines,
  renderWorkStateLines,
  WORK_STATE_SECTION_CHARACTER_LIMIT,
} from '../../../context/sections/WorkStateRenderer.js';

export { MAX_WORK_STATE_FIELDS_JSON_CHARS };

// z.record intentionally drops __proto__; here every field is a primitive,
// so validate own entries and copy with spread to keep literal data keys safely.
// An integer past 2^53 cannot cross cloud sync's canonical JSON
// (CanonicalContent), so it is refused here instead of quarantined later.
const workStateFieldsSchema = z.custom<WorkStateFields>(value =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, field]) => key.length > 0 && (
      field === null || typeof field === 'string' || typeof field === 'boolean'
      || (typeof field === 'number' && Number.isFinite(field) && (!Number.isInteger(field) || Number.isSafeInteger(field)))
    )),
  'fields must map non-empty keys to strings, safe finite numbers, booleans or null',
).transform(fields => ({ ...fields }));

const workStateWriteSchema = z.object({
  cwd: z.string().trim().min(1),
  list: z.string().trim().min(1).max(200),
  fields: workStateFieldsSchema
    .refine(fields => Object.keys(fields).length > 0, 'fields must set at least one key')
    .refine(
      fields => JSON.stringify(fields).length <= MAX_WORK_STATE_FIELDS_JSON_CHARS,
      `fields must be at most ${MAX_WORK_STATE_FIELDS_JSON_CHARS} characters as JSON`,
    ),
});

const CLOSING_STATUSES = ['dropped', 'done'];
/** Why an owner-goals row cannot be saved, or null. List state rows and a row that only closes an item need no kind. */
export function ownerGoalsRowRefusal(fields: WorkStateFields): string | null {
  if (fields.task == null || fields.task === '') return null;
  const onlyCloses = Object.keys(fields).every(key => key === 'task' || key === 'status') && CLOSING_STATUSES.includes(String(fields.status));
  if (onlyCloses && !('goal_kind' in fields)) return null;
  if (!(GOAL_KINDS as unknown[]).includes(fields.goal_kind)) {
    return `an owner-goals item needs goal_kind ${GOAL_KINDS.map(kind => `"${kind}"`).join(' or ')}; got ${JSON.stringify(fields.goal_kind ?? null)}.`;
  }
  return null;
}

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

    // My Rules rows become the user-level CLAUDE.md import (MY-RULES.md), so they are written only by the
    // origin-checked /api/work-view/rules handler, never by an agent session or another local page.
    if (isMyRulesList(list)) {
      res.status(403).send(`Not saved: "${list}" is written only from My Rules in the claude-mem viewer.`);
      return;
    }
    // My Focus rows are the owner's areas and placements; only the origin-checked /api/work-view/focus handler writes them.
    if (isMyFocusList(list)) {
      res.status(403).send(`Not saved: "${list}" is written only from My Focus in the claude-mem viewer.`);
      return;
    }

    // Goals rows are validated, not blocked: save_goals.py writes them here. An item of a kind My Work cannot read
    // would stop the whole view (the reader throws rather than guess), so it is refused at the door.
    if (isOwnerGoalsList(list)) {
      const refusal = ownerGoalsRowRefusal(fields);
      if (refusal) { res.status(400).send(`Not saved: ${refusal}`); return; }
    }

    const checkout = getProjectContext(cwd);
    const store = this.dbManager.getSessionStore();
    store.appendWorkStateEntry({ project: checkout.primary, listName: list, fields });
    logger.debug('WORKER', 'Work state entry saved', { project: checkout.primary, list });
    // The row is a `work_state` sync op: nudge the push drain (null when sync is off).
    this.dbManager.getCloudSync()?.notify();
    // Only what is still open, cut like the SessionStart section, so a long-kept
    // list does not repeat its closed items on every write.
    const openLines = renderWorkStateLines(store.getWorkStateEntries(checkout.allProjects, list), Date.now());
    const saved = `Saved to "${list}" in ${checkout.primary}.`;
    res.send(openLines.length > 0
      ? fitWorkStateLines(`${saved} Still open in it:`, openLines, WORK_STATE_SECTION_CHARACTER_LIMIT)
      : `${saved} Nothing in it is open now.`);
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
