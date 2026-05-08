// SPDX-License-Identifier: Apache-2.0

import type { Application, Request, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import type { RouteHandler } from '../../../services/server/Server.js';
import { CreateAgentEventSchema } from '../../../core/schemas/agent-event.js';
import type { PostgresPool } from '../../../storage/postgres/pool.js';
import {
  PostgresAgentEventsRepository,
  type CreatePostgresAgentEventInput,
  type PostgresAgentEvent,
} from '../../../storage/postgres/agent-events.js';
import {
  PostgresObservationGenerationJobRepository,
  type PostgresObservationGenerationJob,
} from '../../../storage/postgres/generation-jobs.js';
import { PostgresAuthRepository } from '../../../storage/postgres/auth.js';
import { logger } from '../../../utils/logger.js';
import { requirePostgresServerAuth } from '../../middleware/postgres-auth.js';
import type { ActiveServerBetaQueueManager } from '../../runtime/ActiveServerBetaQueueManager.js';
import type { ServerBetaQueueManager } from '../../runtime/types.js';
import { PostgresServerSessionsRepository } from '../../../storage/postgres/server-sessions.js';
import type { ServerSessionGenerationPolicy } from '../../runtime/SessionGenerationPolicy.js';
import { IngestEventsService, type EnqueueOutcome } from '../../services/IngestEventsService.js';
import { EndSessionService } from '../../services/EndSessionService.js';

const SOURCE_ADAPTER_DEFAULT = 'api';

export interface ServerV1PostgresRoutesOptions {
  pool: PostgresPool;
  queueManager: ServerBetaQueueManager;
  authMode?: string;
  runtime?: string;
  allowLocalDevBypass?: boolean;
  // Queue lookup is exposed as a function so tests can swap the queue manager.
  // When the manager is the disabled adapter, enqueue is silently skipped and
  // the outbox row stays in `queued` state for startup reconciliation to
  // pick up — never claim observations were generated.
  getEventQueue?: () => ReturnType<ActiveServerBetaQueueManager['getQueue']> | null;
  getSummaryQueue?: () => ReturnType<ActiveServerBetaQueueManager['getQueue']> | null;
  sessionPolicy?: ServerSessionGenerationPolicy;
  sessionDebounceWindowMs?: number;
}

interface BatchPreValidationFailure {
  status: number;
  body: { error: string; message: string };
}

const EVENT_QUERY_SCHEMA = z.object({
  generate: z.union([z.literal('true'), z.literal('false')]).optional(),
  wait: z.union([z.literal('true'), z.literal('false')]).optional(),
});

export class ServerV1PostgresRoutes implements RouteHandler {
  private readonly ingestEvents: IngestEventsService;
  private readonly endSession: EndSessionService;

  constructor(private readonly options: ServerV1PostgresRoutesOptions) {
    const ingestOpts: ConstructorParameters<typeof IngestEventsService>[0] = {
      pool: options.pool,
      resolveEventQueue: () => this.resolveEventQueue() as never,
    };
    if (options.sessionPolicy !== undefined) {
      ingestOpts.sessionPolicy = options.sessionPolicy;
    }
    if (options.sessionDebounceWindowMs !== undefined) {
      ingestOpts.sessionDebounceWindowMs = options.sessionDebounceWindowMs;
    }
    this.ingestEvents = new IngestEventsService(ingestOpts);
    this.endSession = new EndSessionService({
      pool: options.pool,
      resolveSummaryQueue: () => this.resolveSummaryQueue() as never,
    });
  }

  /**
   * Expose the shared services so other route handlers (e.g. the legacy
   * compat adapters in src/server/compat) can call the EXACT same code path
   * — never duplicate ingest/end logic across routes.
   */
  getIngestEventsService(): IngestEventsService {
    return this.ingestEvents;
  }

  getEndSessionService(): EndSessionService {
    return this.endSession;
  }

  setupRoutes(app: Application): void {
    const writeAuth = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:write'],
    });
    const readAuth = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      requiredScopes: ['memories:read'],
    });

    // POST /v1/events — single event with optional async generation
    app.post('/v1/events', writeAuth, this.asyncHandler(async (req, res) => {
      const parsedQuery = EVENT_QUERY_SCHEMA.safeParse(req.query);
      if (!parsedQuery.success) {
        res.status(400).json({ error: 'ValidationError', issues: parsedQuery.error.issues });
        return;
      }
      const generate = parsedQuery.data.generate !== 'false';
      const wait = parsedQuery.data.wait === 'true';

      const result = CreateAgentEventSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues });
        return;
      }
      const body = result.data;
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return;

      const insertInput = this.toAgentEventInput(body, teamId);
      let event: PostgresAgentEvent;
      let outbox: PostgresObservationGenerationJob | null = null;
      let enqueueState: EnqueueOutcome = 'skipped';
      try {
        const result = await this.ingestEvents.ingestOne(insertInput, {
          generate,
          source: 'http_post_v1_events',
          apiKeyId: req.authContext?.apiKeyId ?? null,
          actorId: await this.resolveActorId(req),
          sourceAdapter: insertInput.sourceAdapter,
        });
        event = result.event;
        outbox = result.outbox;
        enqueueState = result.enqueueState;
      } catch (error) {
        this.handleDbError(error, res, 'event.write');
        return;
      }

      await this.auditWrite(req, 'event.received', event.id, event.projectId, {
        sourceAdapter: event.sourceAdapter,
        sourceEventId: event.sourceEventId,
        eventType: event.eventType,
        serverSessionId: event.serverSessionId,
        generationJobId: outbox?.id ?? null,
      });

      if (wait) {
        res.status(201).json({
          event: serializeEvent(event),
          generationJob: outbox ? serializeJobStatusResponse(outbox, enqueueState) : null,
        });
        return;
      }

      res.status(201).json({
        event: serializeEvent(event),
        ...(outbox
          ? { generationJob: serializeGenerationJob(outbox, enqueueState) }
          : {}),
      });
    }));

    // POST /v1/events/batch — pre-validate, atomic insert, then enqueue
    app.post('/v1/events/batch', writeAuth, this.asyncHandler(async (req, res) => {
      const parsedQuery = EVENT_QUERY_SCHEMA.safeParse(req.query);
      if (!parsedQuery.success) {
        res.status(400).json({ error: 'ValidationError', issues: parsedQuery.error.issues });
        return;
      }
      const generate = parsedQuery.data.generate !== 'false';
      const wait = parsedQuery.data.wait === 'true';

      const batchSchema = z.array(CreateAgentEventSchema).min(1).max(500);
      const result = batchSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues });
        return;
      }
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const failure = preValidateBatch(req, result.data);
      if (failure) {
        res.status(failure.status).json(failure.body);
        return;
      }

      const inputs = result.data.map(item => this.toAgentEventInput(item, teamId));

      let inserted: { event: PostgresAgentEvent; outbox: PostgresObservationGenerationJob | null }[] = [];
      let enqueueResults: EnqueueOutcome[] = [];
      try {
        const ingested = await this.ingestEvents.ingestBatch(inputs, {
          generate,
          source: 'http_post_v1_events_batch',
          apiKeyId: req.authContext?.apiKeyId ?? null,
          actorId: await this.resolveActorId(req),
          sourceAdapter: inputs[0]?.sourceAdapter ?? SOURCE_ADAPTER_DEFAULT,
        });
        inserted = ingested.map(({ event, outbox }) => ({ event, outbox }));
        enqueueResults = ingested.map(({ enqueueState }) => enqueueState);
      } catch (error) {
        this.handleDbError(error, res, 'event.batch_write');
        return;
      }

      await this.auditWrite(req, 'event.batch_received', null, null, {
        eventCount: inserted.length,
        generationJobIds: inserted.map(({ outbox }) => outbox?.id ?? null).filter(Boolean),
      });

      if (wait) {
        res.status(201).json({
          events: inserted.map(({ event, outbox }, index) => ({
            event: serializeEvent(event),
            generationJob: outbox
              ? serializeJobStatusResponse(outbox, enqueueResults[index]!)
              : null,
          })),
        });
        return;
      }

      res.status(201).json({
        events: inserted.map(({ event, outbox }, index) => ({
          event: serializeEvent(event),
          ...(outbox
            ? { generationJob: serializeGenerationJob(outbox, enqueueResults[index]!) }
            : {}),
        })),
      });
    }));

    // GET /v1/events/:id — scoped read
    app.get('/v1/events/:id', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const eventsRepo = new PostgresAgentEventsRepository(this.options.pool);
      // Look up the event by joining team scope. We need to resolve via list
      // approach since getByIdForScope requires projectId. Instead, look up
      // by scanning the teams' projects: do a direct tenant-scoped query.
      const result = await this.options.pool.query(
        `SELECT * FROM agent_events WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      const row = result.rows[0] as undefined | {
        id: string;
        project_id: string;
        team_id: string;
        server_session_id: string | null;
        source_adapter: string;
        source_event_id: string | null;
        idempotency_key: string;
        event_type: string;
        payload: unknown;
        metadata: unknown;
        occurred_at: Date;
        received_at: Date;
        created_at: Date;
      };
      if (!row) {
        res.status(404).json({ error: 'NotFound', message: 'Event not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, row.project_id)) return;
      const fullEvent = await eventsRepo.getByIdForScope({
        id: row.id,
        projectId: row.project_id,
        teamId,
      });
      if (!fullEvent) {
        res.status(404).json({ error: 'NotFound', message: 'Event not found' });
        return;
      }
      res.json({ event: serializeEvent(fullEvent) });
    }));

    // GET /v1/events/:id/observations — list observations linked to event via observation_sources.
    // Scope is enforced by joining observations.team_id = $teamId and the
    // event ownership check before any rows are returned. Cross-tenant
    // requests are reported as 404 to avoid revealing existence.
    app.get('/v1/events/:id/observations', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);

      const eventResult = await this.options.pool.query(
        `SELECT id, project_id FROM agent_events WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      const eventRow = eventResult.rows[0] as undefined | { id: string; project_id: string };
      if (!eventRow) {
        res.status(404).json({ error: 'NotFound', message: 'Event not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, eventRow.project_id)) return;

      const obsResult = await this.options.pool.query(
        `
          SELECT o.id, o.project_id, o.team_id, o.server_session_id, o.kind, o.content,
                 o.metadata, o.generation_key, o.created_by_job_id, o.created_at, o.updated_at,
                 os.id AS source_id_pk, os.source_type, os.source_id, os.generation_job_id, os.created_at AS source_created_at
          FROM observation_sources os
          INNER JOIN observations o ON o.id = os.observation_id
          WHERE os.source_type = 'agent_event'
            AND os.source_id = $1
            AND o.team_id = $2
            AND o.project_id = $3
          ORDER BY o.created_at ASC
        `,
        [eventRow.id, teamId, eventRow.project_id],
      );

      await this.auditRead(req, 'observation.read', eventRow.id, eventRow.project_id, {
        mode: 'event_observations',
        eventId: eventRow.id,
        resultCount: obsResult.rows.length,
        observationIds: obsResult.rows.map(r => r.id),
      });

      res.json({
        eventId: eventRow.id,
        observations: obsResult.rows.map(serializeObservationWithSource),
      });
    }));

    // Phase 11 — team-scoped queue listing. The api key MUST be bound to this
    // team OR a project owned by this team. We never let a project-scoped key
    // read a sibling project's jobs even if it has team-level read scope, so
    // we fall through to a project-only filter when projectId is set on the
    // key. Cross-team requests return 404 to avoid leaking team existence.
    app.get('/v1/teams/:teamId/jobs', readAuth, this.asyncHandler(async (req, res) => {
      const callerTeamId = this.requireTeamId(req, res);
      if (!callerTeamId) return;
      const targetTeamId = this.routeParam(req.params.teamId);
      if (!targetTeamId) {
        res.status(400).json({ error: 'ValidationError', message: 'teamId required' });
        return;
      }
      if (targetTeamId !== callerTeamId) {
        // Don't leak existence — return 404 not 403.
        res.status(404).json({ error: 'NotFound', message: 'Team not found' });
        return;
      }
      const callerProjectId = req.authContext?.projectId ?? null;
      const { status, limit, offset } = parseJobListingQuery(req);
      try {
        const { jobs, total } = await this.listJobsForScope({
          teamId: callerTeamId,
          projectId: callerProjectId,
          status,
          limit,
          offset,
        });
        await this.auditRead(req, 'observation.read', null, callerProjectId, {
          mode: 'team_jobs',
          teamId: callerTeamId,
          projectId: callerProjectId,
          status,
          limit,
          offset,
          resultCount: jobs.length,
        });
        res.status(200).json({
          jobs: jobs.map(serializeJobListEntry),
          total,
          limit,
          offset,
        });
      } catch (error) {
        this.handleDbError(error, res, 'team.jobs.list');
      }
    }));

    // Phase 11 — project-scoped queue listing. Project-scoped api keys MAY
    // read this; team-scoped keys MAY read any project under their team.
    // Cross-tenant requests are reported as 404, matching the rest of the
    // routes so existence is never inferable from response status.
    app.get('/v1/projects/:projectId/jobs', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const projectId = this.routeParam(req.params.projectId);
      if (!projectId) {
        res.status(400).json({ error: 'ValidationError', message: 'projectId required' });
        return;
      }
      // Verify the project actually belongs to this team. Cross-team
      // requests must look identical to "no such project" responses.
      const projectResult = await this.options.pool.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1 AND team_id = $2',
        [projectId, teamId],
      );
      if (projectResult.rows.length === 0) {
        res.status(404).json({ error: 'NotFound', message: 'Project not found' });
        return;
      }
      // Project-scoped key must match the requested project; team-scoped key
      // (no projectId on the key) is allowed.
      const callerProjectId = req.authContext?.projectId ?? null;
      if (callerProjectId && callerProjectId !== projectId) {
        res.status(404).json({ error: 'NotFound', message: 'Project not found' });
        return;
      }

      const { status, limit, offset } = parseJobListingQuery(req);
      try {
        const { jobs, total } = await this.listJobsForScope({
          teamId,
          projectId,
          status,
          limit,
          offset,
        });
        await this.auditRead(req, 'observation.read', null, projectId, {
          mode: 'project_jobs',
          teamId,
          projectId,
          status,
          limit,
          offset,
          resultCount: jobs.length,
        });
        res.status(200).json({
          jobs: jobs.map(serializeJobListEntry),
          total,
          limit,
          offset,
        });
      } catch (error) {
        this.handleDbError(error, res, 'project.jobs.list');
      }
    }));

    // GET /v1/jobs/:id — generation job status, scoped to team/project
    app.get('/v1/jobs/:id', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      // Scope-first lookup. We resolve project_id via the row itself, then
      // re-validate against the api key's project scope. A row that does not
      // match team_id is reported as 404 to avoid revealing existence across
      // tenants.
      const result = await this.options.pool.query(
        `SELECT * FROM observation_generation_jobs WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      const row = result.rows[0] as undefined | { project_id: string };
      if (!row) {
        res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
        return;
      }
      if (req.authContext?.projectId && req.authContext.projectId !== row.project_id) {
        res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
        return;
      }
      const repo = new PostgresObservationGenerationJobRepository(this.options.pool);
      const job = await repo.getByIdForScope({ id, projectId: row.project_id, teamId });
      if (!job) {
        res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
        return;
      }
      res.json({ generationJob: serializeGenerationJobStatus(job) });
    }));

    // POST /v1/sessions/start — create-or-find a server_session, idempotent
    // on (project_id, external_session_id). Body matches the worker
    // /v1/sessions/start payload but stores into Postgres server_sessions.
    app.post('/v1/sessions/start', writeAuth, this.handleCreate(
      z.object({
        projectId: z.string().min(1),
        externalSessionId: z.string().min(1).optional(),
        contentSessionId: z.string().min(1).nullable().optional(),
        agentId: z.string().min(1).nullable().optional(),
        agentType: z.string().min(1).nullable().optional(),
        platformSource: z.string().min(1).nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
        const repo = new PostgresServerSessionsRepository(this.options.pool);
        try {
          if (body.externalSessionId) {
            const existing = await repo.findByExternalIdForScope({
              externalSessionId: body.externalSessionId,
              projectId: body.projectId,
              teamId,
            });
            if (existing) {
              res.status(200).json({ session: serializeSession(existing) });
              return;
            }
          }
          const session = await repo.create({
            projectId: body.projectId,
            teamId,
            externalSessionId: body.externalSessionId ?? null,
            contentSessionId: body.contentSessionId ?? null,
            agentId: body.agentId ?? null,
            agentType: body.agentType ?? null,
            platformSource: body.platformSource ?? null,
            metadata: (body.metadata ?? {}) as Record<string, unknown>,
          });
          await this.auditWrite(req, 'session.write', session.id, session.projectId);
          res.status(201).json({ session: serializeSession(session) });
        } catch (error) {
          this.handleDbError(error, res, 'session.write');
        }
      },
    ));

    // GET /v1/sessions/:id — scoped read, 404 cross-tenant.
    app.get('/v1/sessions/:id', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const result = await this.options.pool.query(
        `SELECT id, project_id FROM server_sessions WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      const row = result.rows[0] as undefined | { id: string; project_id: string };
      if (!row) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, row.project_id)) return;
      const repo = new PostgresServerSessionsRepository(this.options.pool);
      const session = await repo.getByIdForScope({ id, projectId: row.project_id, teamId });
      if (!session) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }
      res.json({ session: serializeSession(session) });
    }));

    // POST /v1/sessions/:id/end — set ended_at (idempotent), enqueue a
    // session-summary generation job. Re-ending the same session is a no-op
    // because the (team_id, project_id, source_type='session_summary',
    // source_id) UNIQUE constraint on observation_generation_jobs prevents
    // duplicate rows; the existing row is returned.
    app.post('/v1/sessions/:id/end', writeAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const result = await this.options.pool.query(
        `SELECT id, project_id FROM server_sessions WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      const row = result.rows[0] as undefined | { id: string; project_id: string };
      if (!row) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, row.project_id)) return;

      let endedSession: Awaited<ReturnType<PostgresServerSessionsRepository['endSession']>> = null;
      let summaryOutbox: PostgresObservationGenerationJob | null = null;
      let enqueueState: EnqueueOutcome = 'skipped';
      try {
        const result = await this.endSession.end({
          sessionId: id,
          projectId: row.project_id,
          teamId,
          source: 'http_post_v1_sessions_end',
          apiKeyId: req.authContext?.apiKeyId ?? null,
          actorId: await this.resolveActorId(req),
          sourceAdapter: 'api',
        });
        endedSession = result.session;
        summaryOutbox = result.outbox;
        enqueueState = result.enqueueState;
      } catch (error) {
        this.handleDbError(error, res, 'session.end');
        return;
      }

      if (!endedSession) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }

      await this.auditWrite(req, 'session.end', endedSession.id, endedSession.projectId);

      res.status(200).json({
        session: serializeSession(endedSession),
        ...(summaryOutbox
          ? { generationJob: serializeGenerationJob(summaryOutbox, enqueueState) }
          : {}),
      });
    }));

    // POST /v1/memories — direct/manual observation insertion (compat alias).
    // MUST NOT call generator and MUST NOT create outbox rows.
    app.post('/v1/memories', writeAuth, this.handleCreate(
      z.object({
        projectId: z.string().min(1),
        serverSessionId: z.string().min(1).nullable().optional(),
        kind: z.string().min(1).optional(),
        content: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
        try {
          const { PostgresObservationRepository } = await import(
            '../../../storage/postgres/observations.js'
          );
          const repo = new PostgresObservationRepository(this.options.pool);
          const observation = await repo.create({
            projectId: body.projectId,
            teamId,
            serverSessionId: body.serverSessionId ?? null,
            kind: body.kind ?? 'manual',
            content: body.content,
            metadata: body.metadata ?? {},
          });
          await this.auditWrite(req, 'memory.write', observation.id, observation.projectId);
          res.status(201).json({ memory: serializeObservation(observation) });
        } catch (error) {
          this.handleDbError(error, res, 'memory.write');
        }
      },
    ));

    // Phase 8 — full-text search over generated observations using the GIN
    // tsvector index. Results are ranked by ts_rank desc, then updated_at desc.
    // The MCP `observation_search` tool calls this endpoint via HTTP so the
    // single source of truth for the read path is the REST core.
    app.post('/v1/search', readAuth, this.handleCreate(
      z.object({
        projectId: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
        try {
          const { PostgresObservationRepository } = await import(
            '../../../storage/postgres/observations.js'
          );
          const repo = new PostgresObservationRepository(this.options.pool);
          const results = await repo.search({
            projectId: body.projectId,
            teamId,
            query: body.query,
            limit: body.limit ?? 20,
          });
          await this.auditRead(req, 'observation.read', null, body.projectId, {
            mode: 'search',
            query: body.query,
            limit: body.limit ?? 20,
            resultCount: results.length,
            observationIds: results.map(o => o.id),
          });
          res.status(200).json({
            observations: results.map(serializeObservation),
          });
        } catch (error) {
          this.handleDbError(error, res, 'observation.search');
        }
      },
    ));

    // Phase 8 — context pack: same FTS path as `/v1/search`, but also returns
    // a concatenated context string for direct prompt injection. The MCP
    // `observation_context` tool calls this so MCP and any future REST
    // consumer share the exact same context-packing rule.
    app.post('/v1/context', readAuth, this.handleCreate(
      z.object({
        projectId: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
        try {
          const { PostgresObservationRepository } = await import(
            '../../../storage/postgres/observations.js'
          );
          const repo = new PostgresObservationRepository(this.options.pool);
          const results = await repo.search({
            projectId: body.projectId,
            teamId,
            query: body.query,
            limit: body.limit ?? 10,
          });
          const context = results
            .map(observation => observation.content)
            .filter(text => typeof text === 'string' && text.length > 0)
            .join('\n\n');
          await this.auditRead(req, 'observation.read', null, body.projectId, {
            mode: 'context',
            query: body.query,
            limit: body.limit ?? 10,
            resultCount: results.length,
            observationIds: results.map(o => o.id),
          });
          res.status(200).json({
            observations: results.map(serializeObservation),
            context,
          });
        } catch (error) {
          this.handleDbError(error, res, 'observation.context');
        }
      },
    ));
  }

  private async auditRead(
    req: Request,
    action: string,
    targetId: string | null,
    projectId: string | null,
    details?: Record<string, unknown>,
  ): Promise<void> {
    return this.auditWrite(req, action, targetId, projectId, details);
  }

  // Phase 11 — resolve actor identity for audit. We look up the api_keys row
  // by id and read its actor_id column. This MUST NOT be used for auth — it
  // is purely a denormalization for audit trails. If the lookup fails for
  // any reason we return null and let the audit row carry a missing actor.
  private async resolveActorId(req: Request): Promise<string | null> {
    const apiKeyId = req.authContext?.apiKeyId ?? null;
    if (!apiKeyId) return null;
    try {
      const result = await this.options.pool.query<{ actor_id: string | null }>(
        'SELECT actor_id FROM api_keys WHERE id = $1',
        [apiKeyId],
      );
      return result.rows[0]?.actor_id ?? null;
    } catch (error) {
      logger.warn('SYSTEM', 'failed to resolve actor_id for audit', {
        apiKeyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private resolveSummaryQueue(): ReturnType<ActiveServerBetaQueueManager['getQueue']> | null {
    if (this.options.getSummaryQueue) {
      return this.options.getSummaryQueue();
    }
    const manager = this.options.queueManager as Partial<ActiveServerBetaQueueManager>;
    if (typeof manager.getQueue === 'function') {
      try {
        return manager.getQueue('summary');
      } catch {
        return null;
      }
    }
    return null;
  }

  private resolveEventQueue(): ReturnType<ActiveServerBetaQueueManager['getQueue']> | null {
    if (this.options.getEventQueue) {
      return this.options.getEventQueue();
    }
    const manager = this.options.queueManager as Partial<ActiveServerBetaQueueManager>;
    if (typeof manager.getQueue === 'function') {
      try {
        return manager.getQueue('event');
      } catch {
        return null;
      }
    }
    return null;
  }

  private toAgentEventInput(body: z.infer<typeof CreateAgentEventSchema>, teamId: string): CreatePostgresAgentEventInput {
    const sourceAdapter = body.sourceType ?? SOURCE_ADAPTER_DEFAULT;
    const occurredAtEpoch = typeof body.occurredAtEpoch === 'number' ? body.occurredAtEpoch : Date.now();
    return {
      projectId: body.projectId,
      teamId,
      serverSessionId: body.serverSessionId ?? null,
      sourceAdapter,
      sourceEventId: typeof (body as Record<string, unknown>).sourceEventId === 'string'
        ? ((body as Record<string, unknown>).sourceEventId as string)
        : null,
      eventType: body.eventType,
      payload: (body.payload ?? {}) as object,
      metadata: typeof (body as Record<string, unknown>).metadata === 'object'
        && (body as Record<string, unknown>).metadata !== null
        ? ((body as Record<string, unknown>).metadata as Record<string, unknown>)
        : {},
      occurredAt: new Date(occurredAtEpoch),
    };
  }

  private requireTeamId(req: Request, res: Response): string | null {
    const teamId = req.authContext?.teamId ?? null;
    if (!teamId) {
      res.status(403).json({ error: 'Forbidden', message: 'API key is not bound to a team' });
      return null;
    }
    return teamId;
  }

  private ensureProjectAllowed(req: Request, res: Response, projectId: string): boolean {
    if (req.authContext?.projectId && req.authContext.projectId !== projectId) {
      res.status(403).json({ error: 'Forbidden', message: 'API key is scoped to a different project' });
      return false;
    }
    return true;
  }

  private handleDbError(error: unknown, res: Response, action: string): void {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('project_id must belong to team_id')
      || message.includes('server_session_id must belong')
      || message.includes('agent_event source_id must belong')
    ) {
      res.status(403).json({ error: 'Forbidden', message });
      return;
    }
    logger.error('SYSTEM', `${action} failed`, { error: message });
    res.status(500).json({ error: 'InternalError', message: 'Failed to persist event' });
  }

  private async auditWrite(
    req: Request,
    action: string,
    targetId: string | null,
    projectId: string | null,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const repo = new PostgresAuthRepository(this.options.pool);
      const actorId = await this.resolveActorId(req);
      await repo.createAuditLog({
        teamId: req.authContext?.teamId ?? null,
        projectId: projectId ?? req.authContext?.projectId ?? null,
        actorId,
        apiKeyId: req.authContext?.apiKeyId ?? null,
        action,
        resourceType: resolveAuditResourceType(action),
        resourceId: targetId,
        details: details ?? {},
      });
    } catch (error) {
      logger.warn('SYSTEM', 'audit log insert failed', {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Phase 11 — paginated job listing for team/project queue endpoints.
  // Filtering is enforced in SQL (WHERE team_id [, project_id, status]).
  // We never trust application-layer filtering alone for tenant scope.
  private async listJobsForScope(input: {
    teamId: string;
    projectId: string | null;
    status: string | null;
    limit: number;
    offset: number;
  }): Promise<{ jobs: JobListRow[]; total: number }> {
    const params: Array<string | number> = [input.teamId];
    let where = 'WHERE team_id = $1';
    if (input.projectId) {
      params.push(input.projectId);
      where += ` AND project_id = $${params.length}`;
    }
    if (input.status) {
      params.push(input.status);
      where += ` AND status = $${params.length}`;
    }
    const totalResult = await this.options.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM observation_generation_jobs ${where}`,
      params,
    );
    const total = Number.parseInt(totalResult.rows[0]?.total ?? '0', 10);
    params.push(input.limit, input.offset);
    const limitParamIndex = params.length - 1;
    const offsetParamIndex = params.length;
    const result = await this.options.pool.query<JobListRow>(
      `
        SELECT id, project_id, team_id, source_type, source_id, status, attempts,
               max_attempts, created_at, completed_at, failed_at, last_error
        FROM observation_generation_jobs
        ${where}
        ORDER BY created_at DESC
        LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      `,
      params,
    );
    return { jobs: result.rows, total };
  }

  private routeParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }
    return value ?? '';
  }

  private handleCreate<S extends ZodTypeAny, T = z.infer<S>>(
    schema: S,
    handler: (req: Request, res: Response, body: T) => Promise<void> | void,
  ) {
    return this.asyncHandler(async (req: Request, res: Response) => {
      const result = schema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues });
        return;
      }
      await handler(req, res, result.data as T);
    });
  }

  private asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
    return (req: Request, res: Response, next: (err?: unknown) => void): void => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  }
}

interface JobListRow {
  id: string;
  project_id: string;
  team_id: string;
  source_type: string;
  source_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error: unknown;
}

const JOB_LIST_STATUS_VALUES = new Set(['queued', 'processing', 'completed', 'failed', 'cancelled']);
const JOB_LIST_DEFAULT_LIMIT = 50;
const JOB_LIST_MAX_LIMIT = 200;

function parseJobListingQuery(req: Request): {
  status: string | null;
  limit: number;
  offset: number;
} {
  const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const status = statusRaw && JOB_LIST_STATUS_VALUES.has(statusRaw) ? statusRaw : null;
  const limit = clampInt(req.query.limit, JOB_LIST_DEFAULT_LIMIT, 1, JOB_LIST_MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { status, limit, offset };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function serializeJobListEntry(row: JobListRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAtEpoch: new Date(row.created_at).getTime(),
    completedAtEpoch: row.completed_at ? new Date(row.completed_at).getTime() : null,
    failedAtEpoch: row.failed_at ? new Date(row.failed_at).getTime() : null,
    lastError: row.last_error && typeof row.last_error === 'object' ? row.last_error : null,
  };
}

// Phase 11 — every audit `action` carries a stable resource_type so dashboards
// can group/filter consistently. We map the dotted action name to a canonical
// resource_type keyword. Unknown actions fall back to the prefix (matches the
// previous behavior for backward compatibility).
function resolveAuditResourceType(action: string): string {
  const map: Record<string, string> = {
    'event.received': 'agent_event',
    'event.batch_received': 'agent_event',
    'event.write': 'agent_event',
    'event.batch_write': 'agent_event',
    'session.write': 'server_session',
    'session.end': 'server_session',
    'memory.write': 'observation',
    'observation.read': 'observation',
    'observation.search': 'observation',
    'observation.context': 'observation',
    'observation.generated': 'observation',
    'session_summary.generated': 'observation',
    'generation_job.queued': 'observation_generation_job',
    'generation_job.enqueued': 'observation_generation_job',
    'generation_job.processing': 'observation_generation_job',
    'generation_job.completed': 'observation_generation_job',
    'generation_job.failed': 'observation_generation_job',
    'generation_job.scope_violation': 'observation_generation_job',
    'generation_job.revoked_key': 'observation_generation_job',
  };
  if (map[action]) return map[action]!;
  return action.split('.')[0] ?? 'unknown';
}

function preValidateBatch(
  req: Request,
  events: { projectId: string }[],
): BatchPreValidationFailure | null {
  const apiKeyProjectId = req.authContext?.projectId ?? null;
  const teamId = req.authContext?.teamId ?? null;
  if (!teamId) {
    return {
      status: 403,
      body: { error: 'Forbidden', message: 'API key is not bound to a team' },
    };
  }
  if (!apiKeyProjectId) {
    // No api-key project scope: every event must be in same team. Team
    // ownership is enforced by repos via `assertProjectOwnership`, but here
    // we only check the api-key cross-tenant bound.
    return null;
  }
  for (const event of events) {
    if (event.projectId !== apiKeyProjectId) {
      return {
        status: 403,
        body: {
          error: 'Forbidden',
          message: 'API key is scoped to a different project',
        },
      };
    }
  }
  return null;
}

function serializeSession(session: {
  id: string;
  projectId: string;
  teamId: string;
  externalSessionId: string | null;
  contentSessionId: string | null;
  agentId: string | null;
  agentType: string | null;
  platformSource: string | null;
  generationStatus: string;
  metadata: Record<string, unknown>;
  startedAtEpoch: number;
  endedAtEpoch: number | null;
  lastGeneratedAtEpoch: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}): Record<string, unknown> {
  return {
    id: session.id,
    projectId: session.projectId,
    teamId: session.teamId,
    externalSessionId: session.externalSessionId,
    contentSessionId: session.contentSessionId,
    agentId: session.agentId,
    agentType: session.agentType,
    platformSource: session.platformSource,
    generationStatus: session.generationStatus,
    metadata: session.metadata,
    startedAtEpoch: session.startedAtEpoch,
    endedAtEpoch: session.endedAtEpoch,
    lastGeneratedAtEpoch: session.lastGeneratedAtEpoch,
    createdAtEpoch: session.createdAtEpoch,
    updatedAtEpoch: session.updatedAtEpoch,
  };
}

function serializeEvent(event: PostgresAgentEvent): Record<string, unknown> {
  return {
    id: event.id,
    projectId: event.projectId,
    teamId: event.teamId,
    serverSessionId: event.serverSessionId,
    sourceAdapter: event.sourceAdapter,
    sourceEventId: event.sourceEventId,
    eventType: event.eventType,
    payload: event.payload,
    metadata: event.metadata,
    occurredAtEpoch: event.occurredAtEpoch,
    receivedAtEpoch: event.receivedAtEpoch,
    createdAtEpoch: event.createdAtEpoch,
  };
}

function serializeObservation(observation: {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}): Record<string, unknown> {
  return {
    id: observation.id,
    projectId: observation.projectId,
    teamId: observation.teamId,
    serverSessionId: observation.serverSessionId,
    kind: observation.kind,
    content: observation.content,
    metadata: observation.metadata,
    createdAtEpoch: observation.createdAtEpoch,
    updatedAtEpoch: observation.updatedAtEpoch,
  };
}

interface ObservationWithSourceRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  kind: string;
  content: string;
  metadata: unknown;
  generation_key: string | null;
  created_by_job_id: string | null;
  created_at: Date;
  updated_at: Date;
  source_id_pk: string;
  source_type: string;
  source_id: string;
  generation_job_id: string | null;
  source_created_at: Date;
}

function serializeObservationWithSource(row: ObservationWithSourceRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    generationKey: row.generation_key,
    createdByJobId: row.created_by_job_id,
    createdAtEpoch: new Date(row.created_at).getTime(),
    updatedAtEpoch: new Date(row.updated_at).getTime(),
    source: {
      id: row.source_id_pk,
      sourceType: row.source_type,
      sourceId: row.source_id,
      generationJobId: row.generation_job_id,
      createdAtEpoch: new Date(row.source_created_at).getTime(),
    },
  };
}

function serializeGenerationJob(
  job: PostgresObservationGenerationJob,
  enqueueState: 'enqueued' | 'queued_only' | 'skipped',
): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    bullmqJobId: job.bullmqJobId,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    transport: enqueueState,
    createdAtEpoch: job.createdAtEpoch,
    updatedAtEpoch: job.updatedAtEpoch,
  };
}

// `?wait=true` returns ONLY queue-acceptance / job-status. It MUST NOT include
// observation IDs or claim provider generation succeeded — generation is
// asynchronous and Phase 4 does not run providers.
function serializeJobStatusResponse(
  job: PostgresObservationGenerationJob,
  enqueueState: 'enqueued' | 'queued_only' | 'skipped',
): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    transport: enqueueState,
    bullmqJobId: job.bullmqJobId,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAtEpoch: job.createdAtEpoch,
    updatedAtEpoch: job.updatedAtEpoch,
  };
}

function serializeGenerationJobStatus(
  job: PostgresObservationGenerationJob,
): Record<string, unknown> {
  return {
    id: job.id,
    projectId: job.projectId,
    teamId: job.teamId,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    agentEventId: job.agentEventId,
    serverSessionId: job.serverSessionId,
    jobType: job.jobType,
    status: job.status,
    bullmqJobId: job.bullmqJobId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextAttemptAtEpoch: job.nextAttemptAtEpoch,
    completedAtEpoch: job.completedAtEpoch,
    failedAtEpoch: job.failedAtEpoch,
    cancelledAtEpoch: job.cancelledAtEpoch,
    lastError: job.lastError,
    createdAtEpoch: job.createdAtEpoch,
    updatedAtEpoch: job.updatedAtEpoch,
  };
}
