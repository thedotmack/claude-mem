// SPDX-License-Identifier: Apache-2.0

// Legacy compatibility — new clients should use POST /v1/events directly.
//
// Legacy worker payloads to `/api/sessions/observations` are translated into
// the Server beta event/job model and delegated to IngestEventsService. The
// adapter never touches worker code, never queues observations directly, and
// never uses `src/services/worker/*` types.
//
// Translation rules:
//   - `contentSessionId` (Claude Code session UUID) becomes the
//     `external_session_id` of a Server beta `server_sessions` row, scoped to
//     the API key's team and project. The session is create-or-found.
//   - The tool-use shape (tool_name, tool_input, tool_response, tool_use_id)
//     is mapped to an `agent_event` with sourceAdapter='claude-code-compat',
//     eventType='tool_use', payload preserves the legacy fields verbatim.
//   - The API key MUST be project-scoped. Cross-project compat calls return
//     400; we never let compat traffic bypass project scope.

import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresServerSessionsRepository } from '../../storage/postgres/server-sessions.js';
import { logger } from '../../utils/logger.js';
import { requirePostgresServerAuth } from '../middleware/postgres-auth.js';
import { IngestEventsService } from '../services/IngestEventsService.js';
import type { CreatePostgresAgentEventInput } from '../../storage/postgres/agent-events.js';

const COMPAT_SOURCE_ADAPTER = 'claude-code-compat';
const COMPAT_EVENT_TYPE = 'tool_use';

const observationsSchema = z.object({
  contentSessionId: z.string().min(1),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  cwd: z.string().optional(),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  platformSource: z.string().optional(),
  tool_use_id: z.string().optional(),
  toolUseId: z.string().optional(),
}).passthrough();

export interface SessionsObservationsAdapterOptions {
  pool: PostgresPool;
  ingestEvents: IngestEventsService;
  authMode?: string;
  allowLocalDevBypass?: boolean;
}

export class SessionsObservationsAdapter implements RouteHandler {
  constructor(private readonly options: SessionsObservationsAdapterOptions) {}

  setupRoutes(app: Application): void {
    const writeAuth = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:write'],
    });

    app.post('/api/sessions/observations', writeAuth, this.asyncHandler(async (req, res) => {
      const parsed = observationsSchema.safeParse(req.body);
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
        // Compat mode requires a project-scoped key — the legacy payload does
        // not carry a Server beta projectId, so without scope we cannot place
        // the row in a tenant-scoped table.
        res.status(400).json({
          error: 'BadRequest',
          message: 'Legacy /api/sessions/observations requires a project-scoped API key',
        });
        return;
      }

      try {
        const session = await resolveServerSession({
          pool: this.options.pool,
          teamId,
          projectId,
          contentSessionId: parsed.data.contentSessionId,
          platformSource: typeof parsed.data.platformSource === 'string' ? parsed.data.platformSource : null,
          agentId: typeof parsed.data.agentId === 'string' ? parsed.data.agentId : null,
          agentType: typeof parsed.data.agentType === 'string' ? parsed.data.agentType : null,
        });

        const toolUseId = typeof parsed.data.tool_use_id === 'string'
          ? parsed.data.tool_use_id
          : (typeof parsed.data.toolUseId === 'string' ? parsed.data.toolUseId : null);

        const input: CreatePostgresAgentEventInput = {
          projectId,
          teamId,
          serverSessionId: session.id,
          sourceAdapter: COMPAT_SOURCE_ADAPTER,
          sourceEventId: toolUseId,
          eventType: COMPAT_EVENT_TYPE,
          payload: {
            contentSessionId: parsed.data.contentSessionId,
            tool_name: parsed.data.tool_name,
            tool_input: parsed.data.tool_input ?? null,
            tool_response: parsed.data.tool_response ?? null,
            cwd: parsed.data.cwd ?? null,
            platformSource: parsed.data.platformSource ?? null,
            agentId: parsed.data.agentId ?? null,
            agentType: parsed.data.agentType ?? null,
            toolUseId,
          },
          metadata: { compat: 'sessions/observations' },
          occurredAt: new Date(),
        };

        const result = await this.options.ingestEvents.ingestOne(input, {
          source: 'http_post_api_sessions_observations',
          apiKeyId: req.authContext?.apiKeyId ?? null,
          actorId: null,
          sourceAdapter: COMPAT_SOURCE_ADAPTER,
        });
        // Legacy response shape — older clients only check `status`.
        res.json({
          status: 'queued',
          observationCount: 1,
          sessionId: session.id,
          serverSessionId: session.id,
          eventId: result.event.id,
          generationJobId: result.outbox?.id ?? null,
          transport: result.enqueueState,
        });
      } catch (error) {
        logger.error('SYSTEM', 'compat observations adapter failed', {
          error: error instanceof Error ? error.message : String(error),
          contentSessionId: parsed.data.contentSessionId,
        });
        res.status(500).json({ stored: false, reason: 'internal_error' });
      }
    }));
  }

  private asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
    return (req: Request, res: Response, next: (err?: unknown) => void): void => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  }
}

/**
 * Look up an existing server_session by (project, team, externalSessionId)
 * or create one if missing. Idempotent: re-issuing for the same content
 * session returns the existing row.
 *
 * Concurrent compat callers can race here — both observe `existing===null`
 * and both call `repo.create`, where the second will hit one of two unique
 * constraints (`(project_id, idempotency_key)` covered by ON CONFLICT, or
 * `(project_id, external_session_id)` which is NOT covered). Catch the
 * unique-violation and re-fetch so the caller never sees a 500.
 */
export async function resolveServerSession(input: {
  pool: PostgresPool;
  teamId: string;
  projectId: string;
  contentSessionId: string;
  platformSource: string | null;
  agentId: string | null;
  agentType: string | null;
}): Promise<{ id: string; projectId: string; teamId: string }> {
  const repo = new PostgresServerSessionsRepository(input.pool);
  const existing = await repo.findByExternalIdForScope({
    externalSessionId: input.contentSessionId,
    projectId: input.projectId,
    teamId: input.teamId,
  });
  if (existing) {
    return { id: existing.id, projectId: existing.projectId, teamId: existing.teamId };
  }
  try {
    const created = await repo.create({
      projectId: input.projectId,
      teamId: input.teamId,
      externalSessionId: input.contentSessionId,
      contentSessionId: input.contentSessionId,
      agentId: input.agentId,
      agentType: input.agentType,
      platformSource: input.platformSource,
    });
    return { id: created.id, projectId: created.projectId, teamId: created.teamId };
  } catch (error) {
    // Postgres unique_violation. A concurrent compat call inserted the row
    // for this (project, external_session_id) before we could; re-fetch
    // and return that row instead of bubbling a 500 to the legacy client.
    if ((error as { code?: string } | null)?.code === '23505') {
      const racedRow = await repo.findByExternalIdForScope({
        externalSessionId: input.contentSessionId,
        projectId: input.projectId,
        teamId: input.teamId,
      });
      if (racedRow) {
        return { id: racedRow.id, projectId: racedRow.projectId, teamId: racedRow.teamId };
      }
    }
    throw error;
  }
}
