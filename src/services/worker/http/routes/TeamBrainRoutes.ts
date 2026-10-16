import express, { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import {
  fetchTeamBrief,
  formatTeamBrief,
  searchTeamBrain,
  teamBrainConnection,
  type TeamBrainConnection,
  type TeamBrainFailure,
  type TeamBrainSettings,
} from '../../../../shared/teambrain.js';

/** An agent's tool call can wait longer than SessionStart's 2 s, but not indefinitely. */
export const TEAMBRAIN_PROXY_TIMEOUT_MS = 10_000;

const teamSearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional(),
});

/**
 * TeamBrain for the team_brief / team_search MCP tools: each route signs its
 * request with this install's cloud sync token and answers in plain text for
 * the agent, like the work-state routes. Registered unconditionally (the
 * CloudSyncRoutes pattern): an install that has not joined a team gets a 409
 * that says so, not a 404 that looks like an old worker.
 */
export class TeamBrainRoutes extends BaseRouteHandler {
  constructor(
    private readSettings: () => Partial<TeamBrainSettings>,
    private upstreamTimeoutMs: number = TEAMBRAIN_PROXY_TIMEOUT_MS,
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/teambrain/brief', this.handleBrief.bind(this));
    app.post('/api/teambrain/search', validateBody(teamSearchSchema), this.handleSearch.bind(this));
  }

  private handleBrief = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = BaseRouteHandler.firstString(req.query.project)?.trim();
    if (!project) {
      this.badRequest(res, 'project is required');
      return;
    }
    const connection = this.connectionOrRefuse(res);
    if (!connection) return;

    const result = await fetchTeamBrief(connection, project, this.upstreamTimeoutMs);
    if (!result.ok) {
      this.sendUpstreamFailure(res, 'brief', result);
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(formatTeamBrief(result.value) || `TeamBrain (${result.value.team.name}) has nothing for ${project} right now.`);
  });

  private handleSearch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { query, limit } = req.body as z.infer<typeof teamSearchSchema>;
    const connection = this.connectionOrRefuse(res);
    if (!connection) return;

    const result = await searchTeamBrain(connection, query, limit, this.upstreamTimeoutMs);
    if (!result.ok) {
      this.sendUpstreamFailure(res, 'search', result);
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(result.value.text || `TeamBrain found nothing your team shared for "${query}".`);
  });

  private connectionOrRefuse(res: Response): TeamBrainConnection | null {
    const connection = teamBrainConnection(this.readSettings());
    if (!connection) {
      res.status(409).json({
        error: 'TeamBrain is not set up on this install.',
        fix: 'Join a team: npx claude-mem teambrain join <invite-link> (or start one: npx claude-mem teambrain start)',
      });
    }
    return connection;
  }

  /** 504 for a timeout, 404 for no team, 502 for anything else the upstream did. */
  private sendUpstreamFailure(res: Response, what: 'brief' | 'search', failure: TeamBrainFailure): void {
    logger.warn('HTTP', `TeamBrain ${what} failed`, { kind: failure.kind, status: failure.status });
    const status = failure.kind === 'timeout' ? 504 : failure.kind === 'not_a_member' ? 404 : 502;
    res.status(status).json({
      error: `TeamBrain ${what} unavailable: ${failure.reason}`,
      ...(failure.kind === 'not_a_member' || failure.kind === 'no_credentials'
        ? { fix: 'Join a team: npx claude-mem teambrain join <invite-link>' }
        : {}),
    });
  }
}
