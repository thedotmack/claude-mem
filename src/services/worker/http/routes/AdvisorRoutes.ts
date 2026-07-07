
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { isProjectExcluded } from '../../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { getProjectContext } from '../../../../utils/project-name.js';

const advisorCallsIngestSchema = z.object({
  contentSessionId: z.string().min(1),
  platformSource: z.string().optional(),
  cwd: z.string().optional(),
  transcriptPath: z.string().optional(),
  calls: z.array(z.object({
    toolUseId: z.string().min(1),
    advice: z.string().min(1),
    advisorModel: z.string().nullable().optional(),
    occurredAtEpoch: z.number().int().nonnegative(),
    lastUserMessage: z.string().nullable().optional(),
    transcriptLineNumber: z.number().int().nullable().optional(),
  })).min(1).max(50),
}).passthrough();

/**
 * Surface for `advisor_calls` — durable, verbatim records of Claude Code
 * `advisor` tool calls. The advisor is a server-side tool (server_tool_use)
 * that never fires PostToolUse, so rows arrive here via the Stop hook's
 * transcript scan (shared/advisor-transcript.ts) posting to /api/advisor-calls;
 * the UNIQUE tool_use_id makes replayed scans no-ops.
 */
export class AdvisorRoutes extends BaseRouteHandler {
  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
    private eventBroadcaster: SessionEventBroadcaster,
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/advisor-calls', this.handleGetAdvisorCalls.bind(this));
    app.get('/api/advisor-call/:id', this.handleGetAdvisorCallById.bind(this));
    app.post('/api/advisor-calls', validateBody(advisorCallsIngestSchema), this.handleIngestAdvisorCalls.bind(this));
  }

  private handleGetAdvisorCalls = this.wrapHandler((req: Request, res: Response): void => {
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    // Clamp to [1, 100]: negative limits would otherwise reach SQLite, where
    // a negative LIMIT means "no limit".
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
    const project = req.query.project as string | undefined;
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    const result = this.paginationHelper.getAdvisorCalls(offset, limit, project, platformSource);
    res.json(result);
  });

  private handleGetAdvisorCallById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const advisorCall = store.getAdvisorCallById(id);

    if (!advisorCall) {
      logger.debug('WORKER', 'Advisor call not found', { id });
      this.notFound(res, `Advisor call #${id} not found`);
      return;
    }

    res.json(advisorCall);
  });

  private handleIngestAdvisorCalls = this.wrapHandler((req: Request, res: Response): void => {
    const { contentSessionId, cwd, transcriptPath, calls } = req.body as z.infer<typeof advisorCallsIngestSchema>;
    const platformSource = this.getPlatformSourceFromRequest(req);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      res.json({ status: 'skipped', reason: 'project_excluded' });
      return;
    }

    const project = typeof cwd === 'string' && cwd.trim() ? getProjectContext(cwd).primary : '';

    const store = this.dbManager.getSessionStore();
    const sessionDbId = store.createSDKSession(contentSessionId, project, '', undefined, platformSource);

    let stored = 0;
    let duplicates = 0;
    for (const call of calls) {
      const result = store.recordAdvisorCall({
        sessionDbId,
        contentSessionId,
        project,
        platformSource,
        toolUseId: call.toolUseId,
        advisorModel: call.advisorModel ?? null,
        cwd: cwd ?? null,
        lastUserMessage: call.lastUserMessage ?? null,
        transcriptPath: transcriptPath ?? null,
        transcriptLineNumber: call.transcriptLineNumber ?? null,
        advice: call.advice,
        occurredAtEpoch: call.occurredAtEpoch,
      });

      if (result.inserted) {
        stored++;
        const row = store.getAdvisorCallById(result.id);
        if (row) {
          this.eventBroadcaster.broadcastNewAdvisorCall(row);
        }
      } else {
        duplicates++;
      }
    }

    logger.debug('WORKER', 'Advisor calls ingested', { contentSessionId, stored, duplicates });
    res.json({ status: 'stored', stored, duplicates });
  });
}
