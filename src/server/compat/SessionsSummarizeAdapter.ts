// SPDX-License-Identifier: Apache-2.0

// Legacy compatibility — new clients should use POST /v1/sessions/:id/end directly.
//
// Translates the legacy `/api/sessions/summarize` request into a call to
// EndSessionService. The legacy shape carries `contentSessionId` and an
// optional `last_assistant_message`; we resolve the server_session by
// (team, project, external_session_id=contentSessionId), then end it.
//
// Re-summarizing the same session collapses to the same outbox row because
// the (team_id, project_id, source_type='session_summary', source_id)
// UNIQUE constraint stays in force — exactly the same idempotency guarantee
// as `/v1/sessions/:id/end`.

import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresServerSessionsRepository } from '../../storage/postgres/server-sessions.js';
import { logger } from '../../utils/logger.js';
import { requirePostgresServerAuth } from '../middleware/postgres-auth.js';
import { EndSessionService } from '../services/EndSessionService.js';
import { resolveServerSession } from './SessionsObservationsAdapter.js';

const summarizeSchema = z.object({
  contentSessionId: z.string().min(1),
  last_assistant_message: z.string().optional(),
  agentId: z.string().optional(),
  platformSource: z.string().optional(),
}).passthrough();

export interface SessionsSummarizeAdapterOptions {
  pool: PostgresPool;
  endSession: EndSessionService;
  authMode?: string;
  allowLocalDevBypass?: boolean;
}

export class SessionsSummarizeAdapter implements RouteHandler {
  constructor(private readonly options: SessionsSummarizeAdapterOptions) {}

  setupRoutes(app: Application): void {
    const writeAuth = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:write'],
    });

    app.post('/api/sessions/summarize', writeAuth, this.asyncHandler(async (req, res) => {
      const parsed = summarizeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
        return;
      }
      const teamId = req.authContext?.teamId ?? null;
      const projectId = req.authContext?.projectId ?? null;
      if (!teamId) {
        res.status(403).json({ error: 'Forbidden', message: 'API key is not bound to a team' });
        return;
      }
      if (!projectId) {
        res.status(400).json({
          error: 'BadRequest',
          message: 'Legacy /api/sessions/summarize requires a project-scoped API key',
        });
        return;
      }

      // Subagent contexts in legacy code emit summarize calls but the worker
      // skipped them. We preserve the legacy semantics so existing clients
      // see the same response shape.
      if (parsed.data.agentId) {
        res.json({ status: 'skipped', reason: 'subagent_context' });
        return;
      }

      try {
        const session = await resolveServerSession({
          pool: this.options.pool,
          teamId,
          projectId,
          contentSessionId: parsed.data.contentSessionId,
          platformSource: typeof parsed.data.platformSource === 'string' ? parsed.data.platformSource : null,
          agentId: null,
          agentType: null,
        });

        const result = await this.options.endSession.end({
          sessionId: session.id,
          projectId,
          teamId,
          source: 'http_post_api_sessions_summarize',
          apiKeyId: req.authContext?.apiKeyId ?? null,
          actorId: null,
          sourceAdapter: 'claude-code-compat',
        });
        if (!result.session) {
          res.status(404).json({ status: 'not_found', reason: 'session_not_found' });
          return;
        }
        res.json({
          status: 'queued',
          sessionId: session.id,
          serverSessionId: session.id,
          generationJobId: result.outbox?.id ?? null,
          transport: result.enqueueState,
        });
      } catch (error) {
        logger.error('SYSTEM', 'compat summarize adapter failed', {
          error: error instanceof Error ? error.message : String(error),
          contentSessionId: parsed.data.contentSessionId,
        });
        res.status(500).json({ status: 'error', reason: 'internal_error' });
      }
    }));
  }

  private asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
    return (req: Request, res: Response, next: (err?: unknown) => void): void => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  }
}

// Side-effect import so PostgresServerSessionsRepository symbol is reachable
// even when tree-shaking is aggressive in the main bundle.
void PostgresServerSessionsRepository;
