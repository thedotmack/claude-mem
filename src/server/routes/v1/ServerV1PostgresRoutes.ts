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
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
  type PostgresObservationGenerationJob,
} from '../../../storage/postgres/generation-jobs.js';
import { PostgresAuthRepository } from '../../../storage/postgres/auth.js';
import { PostgresObservationRepository } from '../../../storage/postgres/observations.js';
import { logger } from '../../../utils/logger.js';
import { requirePostgresServerAuth } from '../../middleware/postgres-auth.js';
import { requestIdMiddleware } from '../../middleware/request-id.js';
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

// `?wait=true` polls the outbox row until it reaches a terminal status
// (`completed` / `failed` / `cancelled`). Hard-capped so a stuck provider can
// never block an HTTP worker indefinitely; callers always get a response.
const WAIT_TIMEOUT_MS = 30_000;
const WAIT_POLL_INTERVAL_MS = 100;
const TERMINAL_JOB_STATUSES: readonly PostgresObservationGenerationJob['status'][] = [
  'completed',
  'failed',
  'cancelled',
];

async function waitForTerminalJob(
  jobRepo: PostgresObservationGenerationJobRepository,
  job: PostgresObservationGenerationJob,
  timeoutMs: number = WAIT_TIMEOUT_MS,
  intervalMs: number = WAIT_POLL_INTERVAL_MS,
): Promise<{ job: PostgresObservationGenerationJob; timedOut: boolean }> {
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    return { job, timedOut: false };
  }
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const refreshed = await jobRepo.getByIdForScope({
      id: job.id,
      projectId: job.projectId,
      teamId: job.teamId,
    });
    if (!refreshed) {
      return { job: current, timedOut: false };
    }
    current = refreshed;
    if (TERMINAL_JOB_STATUSES.includes(refreshed.status)) {
      return { job: refreshed, timedOut: false };
    }
  }
  return { job: current, timedOut: true };
}

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
    // Phase 12 — request_id middleware MUST run before auth so the audit log
    // can carry a stable correlation id across "rejected at auth" and
    // "ingested" code paths. requestIdMiddleware is idempotent (it honors
    // an inbound X-Request-Id header) so registering it multiple times for
    // overlapping route trees would still produce one canonical id per req.
    app.use('/v1', requestIdMiddleware());
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
          requestId: req.requestId ?? null,
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
        let resolved = outbox;
        let waitTimedOut = false;
        if (outbox) {
          const jobRepo = new PostgresObservationGenerationJobRepository(this.options.pool);
          const result = await waitForTerminalJob(jobRepo, outbox);
          resolved = result.job;
          waitTimedOut = result.timedOut;
        }
        res.status(201).json({
          event: serializeEvent(event),
          generationJob: resolved ? serializeJobStatusResponse(resolved, enqueueState) : null,
          ...(waitTimedOut ? { waitTimedOut: true } : {}),
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
          // Do not pick a single adapter for the whole batch. ingestBatch
          // builds each event's BullMQ payload via buildEventBullmqPayload,
          // which falls back to event.sourceAdapter when this opt is null —
          // so a mixed batch (e.g. 'mcp' + 'api') keeps per-event metadata
          // accurate in both the persisted outbox payload and the audit row.
          sourceAdapter: null,
          requestId: req.requestId ?? null,
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
        const jobRepo = new PostgresObservationGenerationJobRepository(this.options.pool);
        const waitDeadline = Date.now() + WAIT_TIMEOUT_MS;
        const resolved: { event: PostgresAgentEvent; outbox: PostgresObservationGenerationJob | null; timedOut: boolean }[] = [];
        for (const item of inserted) {
          if (!item.outbox) {
            resolved.push({ event: item.event, outbox: null, timedOut: false });
            continue;
          }
          const remaining = Math.max(0, waitDeadline - Date.now());
          const result = await waitForTerminalJob(jobRepo, item.outbox, remaining);
          resolved.push({ event: item.event, outbox: result.job, timedOut: result.timedOut });
        }
        const anyTimedOut = resolved.some(r => r.timedOut);
        res.status(201).json({
          events: resolved.map(({ event, outbox, timedOut }, index) => ({
            event: serializeEvent(event),
            generationJob: outbox
              ? serializeJobStatusResponse(outbox, enqueueResults[index]!)
              : null,
            ...(timedOut ? { waitTimedOut: true } : {}),
          })),
          ...(anyTimedOut ? { waitTimedOut: true } : {}),
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
          jobs: jobs.map(row => serializeJobListEntry(row)),
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
          jobs: jobs.map(row => serializeJobListEntry(row)),
          total,
          limit,
          offset,
        });
      } catch (error) {
        this.handleDbError(error, res, 'project.jobs.list');
      }
    }));

    // Phase 12 — GET /v1/jobs (generic, scoped). Project-scoped key sees its
    // project's jobs; team-scoped key sees the team's jobs. Filters: status,
    // source_type, limit, offset, since (ISO timestamp on created_at). The
    // BullMQ payload column is NEVER returned by default — even with admin
    // scope, the caller MUST opt in via `?include=payload`. This anti-pattern
    // guard prevents accidental exfil of sensitive event payloads.
    app.get('/v1/jobs', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const callerProjectId = req.authContext?.projectId ?? null;
      const includeRaw = typeof req.query.include === 'string' ? req.query.include : '';
      const includePayload = includeRaw.split(',').map(p => p.trim()).includes('payload');
      const callerScopes = req.authContext?.scopes ?? [];
      const isAdmin = callerScopes.includes('*') || callerScopes.includes('admin')
        || callerScopes.includes('memories:admin');
      if (includePayload && !isAdmin) {
        // Anti-pattern guard: refuse the include=payload elevation without
        // admin scope. Returning 403 (not silently stripping) makes the
        // attempted privilege escalation visible in the audit chain.
        res.status(403).json({
          error: 'Forbidden',
          message: '`include=payload` requires admin scope',
        });
        return;
      }
      const { status, sourceType, limit, offset, since } = parseGenericJobListingQuery(req);
      try {
        const { jobs, total } = await this.listJobsForScope({
          teamId,
          projectId: callerProjectId,
          status,
          sourceType,
          limit,
          offset,
          since,
        });
        await this.auditRead(req, 'observation.read', null, callerProjectId, {
          mode: 'jobs_list',
          teamId,
          projectId: callerProjectId,
          status,
          sourceType,
          limit,
          offset,
          since: since ? since.toISOString() : null,
          resultCount: jobs.length,
          includePayload,
          requestId: req.requestId ?? null,
        });
        res.status(200).json({
          jobs: jobs.map(row => serializeJobListEntry(row, { includePayload })),
          total,
          limit,
          offset,
          requestId: req.requestId ?? null,
        });
      } catch (error) {
        this.handleDbError(error, res, 'jobs.list');
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

    // Phase 12 — POST /v1/jobs/:id/retry. Idempotent operator action: if the
    // job is already queued the call is a no-op (no second BullMQ job is
    // enqueued). On failed/cancelled rows, transition back to queued, clear
    // locked_at/locked_by/failed_at/cancelled_at/last_error, increment a
    // retried_count metadata field for audit, and re-enqueue. The Phase 11
    // outbox idempotency key (team_id, project_id, source_type, source_id,
    // job_type) prevents observation duplication on the generator side.
    app.post('/v1/jobs/:id/retry', writeAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const result = await this.retryGenerationJob(req, res, id, teamId);
      if (!result) return;
      res.status(200).json({
        generationJob: serializeGenerationJobStatus(result.job),
        retriedCount: result.retriedCount,
        alreadyQueued: result.alreadyQueued,
        requestId: req.requestId ?? null,
      });
    }));

    // Phase 12 — POST /v1/jobs/:id/cancel. Operator action: set status to
    // cancelled, set cancelled_at, append a lifecycle event, attempt to
    // remove the BullMQ job if still in flight. Future generator runs check
    // the Postgres status FIRST (Phase 11 lockOutbox guard) so a cancelled
    // job will never produce side effects even if BullMQ delivered it.
    app.post('/v1/jobs/:id/cancel', writeAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const result = await this.cancelGenerationJob(req, res, id, teamId);
      if (!result) return;
      res.status(200).json({
        generationJob: serializeGenerationJobStatus(result.job),
        alreadyCancelled: result.alreadyCancelled,
        requestId: req.requestId ?? null,
      });
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
          let session;
          try {
            session = await repo.create({
              projectId: body.projectId,
              teamId,
              externalSessionId: body.externalSessionId ?? null,
              contentSessionId: body.contentSessionId ?? null,
              agentId: body.agentId ?? null,
              agentType: body.agentType ?? null,
              platformSource: body.platformSource ?? null,
              metadata: (body.metadata ?? {}) as Record<string, unknown>,
            });
          } catch (error) {
            // Concurrent /v1/sessions/start with the same externalSessionId
            // can race past the findByExternalIdForScope check; the second
            // insert hits the (project_id, external_session_id) unique
            // constraint. Refetch and return the row inserted by the winner
            // so legacy clients never see a spurious 500.
            if (
              body.externalSessionId &&
              (error as { code?: string } | null)?.code === '23505'
            ) {
              const racedRow = await repo.findByExternalIdForScope({
                externalSessionId: body.externalSessionId,
                projectId: body.projectId,
                teamId,
              });
              if (racedRow) {
                res.status(200).json({ session: serializeSession(racedRow) });
                return;
              }
            }
            throw error;
          }
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
      // Phase 12 — every audit row carries request_id when one was minted
      // so dashboards and incident triage can pivot from a single HTTP
      // request to every ingest/job/audit row it produced. Caller-supplied
      // details win on key conflict so explicit overrides still work.
      const detailsWithRequestId: Record<string, unknown> = {
        ...(req.requestId ? { requestId: req.requestId } : {}),
        ...(details ?? {}),
      };
      await repo.createAuditLog({
        teamId: req.authContext?.teamId ?? null,
        projectId: projectId ?? req.authContext?.projectId ?? null,
        actorId,
        apiKeyId: req.authContext?.apiKeyId ?? null,
        action,
        resourceType: resolveAuditResourceType(action),
        resourceId: targetId,
        details: detailsWithRequestId,
      });
    } catch (error) {
      logger.warn('SYSTEM', 'audit log insert failed', {
        action,
        requestId: req.requestId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Phase 11 — paginated job listing for team/project queue endpoints.
  // Phase 12 — extended with `sourceType`, `since`, and (optional) payload
  // selection. Filtering is enforced in SQL (WHERE team_id [, project_id,
  // status, source_type, created_at]). Application-layer filtering is never
  // trusted alone for tenant scope.
  private async listJobsForScope(input: {
    teamId: string;
    projectId: string | null;
    status: string | null;
    sourceType?: string | null;
    limit: number;
    offset: number;
    since?: Date | null;
  }): Promise<{ jobs: JobListRow[]; total: number }> {
    const params: Array<string | number | Date> = [input.teamId];
    let where = 'WHERE team_id = $1';
    if (input.projectId) {
      params.push(input.projectId);
      where += ` AND project_id = $${params.length}`;
    }
    if (input.status) {
      params.push(input.status);
      where += ` AND status = $${params.length}`;
    }
    if (input.sourceType) {
      params.push(input.sourceType);
      where += ` AND source_type = $${params.length}`;
    }
    if (input.since) {
      params.push(input.since);
      where += ` AND created_at >= $${params.length}`;
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
               max_attempts, created_at, completed_at, failed_at, last_error, payload
        FROM observation_generation_jobs
        ${where}
        ORDER BY created_at DESC
        LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      `,
      params,
    );
    return { jobs: result.rows, total };
  }

  // Phase 12 — operator retry. Status handling:
  //   - queued: no-op (idempotent; no double enqueue)
  //   - processing: 409 — running worker MUST finish or fail naturally
  //   - completed: 409 — observations index dedupes on (job_id, index,
  //     content) but LLM output is non-deterministic, so a second run
  //     would persist a parallel set of observations. Operator must
  //     create a new generation request instead of retrying.
  //   - failed/cancelled: reset to queued, clear locks, bump retried_count
  //     in payload metadata for audit, then re-enqueue. The deterministic
  //     BullMQ jobId means a duplicate transport publish collapses on the
  //     queue side too.
  private async retryGenerationJob(
    req: Request,
    res: Response,
    id: string,
    teamId: string,
  ): Promise<{ job: PostgresObservationGenerationJob; retriedCount: number; alreadyQueued: boolean } | null> {
    if (!id) {
      res.status(400).json({ error: 'ValidationError', message: 'job id required' });
      return null;
    }
    // Scope check first — same NotFound disclosure as the rest of the routes.
    const lookup = await this.options.pool.query(
      `SELECT * FROM observation_generation_jobs WHERE id = $1 AND team_id = $2`,
      [id, teamId],
    );
    const row = lookup.rows[0] as undefined | { project_id: string };
    if (!row) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }
    if (req.authContext?.projectId && req.authContext.projectId !== row.project_id) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    const repo = new PostgresObservationGenerationJobRepository(this.options.pool);
    const current = await repo.getByIdForScope({ id, projectId: row.project_id, teamId });
    if (!current) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    // Idempotent fast-path: already queued -> emit audit only, no DB writes.
    if (current.status === 'queued') {
      await this.auditWrite(req, 'generation_job.retried_by_operator', current.id, current.projectId, {
        outcome: 'noop_already_queued',
        currentAttempts: current.attempts,
        requestId: req.requestId ?? null,
      });
      return { job: current, retriedCount: extractRetriedCount(current.payload), alreadyQueued: true };
    }

    if (current.status === 'processing') {
      // Refuse retry on in-flight jobs — the running worker MUST be allowed
      // to finish or fail through its normal lifecycle. Operator can wait
      // or cancel, then retry.
      res.status(409).json({
        error: 'Conflict',
        message: 'Generation job is currently processing; cancel or wait for completion before retrying',
      });
      return null;
    }

    if (current.status === 'completed') {
      // Refuse retry on already-completed jobs. The deduplication index on
      // observations (generation_key = job_id + index + content) does NOT
      // protect against re-running the provider, because LLM output is
      // non-deterministic and the second run almost always produces a
      // different content string. Replaying would persist a parallel set
      // of observations attributed to the same generation_job_id.
      // cancelGenerationJob applies the same 409 guard for the same reason.
      res.status(409).json({
        error: 'Conflict',
        message: 'Generation job already completed; retrying would duplicate observations',
      });
      return null;
    }

    // Reset to queued, clear lock + lifecycle timestamps, increment
    // retried_count for audit. attempts is intentionally preserved so the
    // BullMQ attempt cap is not bypassed; if the job hit max_attempts the
    // operator must lift the cap explicitly via a separate flow.
    //
    // current.payload is the canonical BullMQ payload persisted at outbox
    // create time (kind/team_id/project_id/source_type/source_id/
    // generation_job_id/api_key_id/actor_id/source_adapter/request_id).
    // The retry adds operator metadata to the persisted row but enqueues
    // ONLY the BullMQ payload — the worker calls
    // assertServerGenerationJobPayload(job.data) on receipt and would reject
    // the metadata-only object the previous implementation handed it.
    const retriedCount = extractRetriedCount(current.payload) + 1;
    const persistedBullmqPayload = (current.payload && typeof current.payload === 'object'
      ? current.payload
      : {}) as Record<string, unknown>;
    const newPayload = {
      ...persistedBullmqPayload,
      retried_count: retriedCount,
      last_retried_by_actor: req.authContext?.apiKeyId ?? null,
      last_retried_request_id: req.requestId ?? null,
    };
    // The payload we re-publish to BullMQ on retry: refresh request_id (so
    // the worker logs/audit attribute this run to the operator's request)
    // but keep all canonical job context that the worker validates against.
    const retryBullmqPayload = {
      ...persistedBullmqPayload,
      request_id: req.requestId ?? (persistedBullmqPayload as { request_id?: unknown }).request_id ?? null,
    };
    const updated = await this.options.pool.query(
      `
        UPDATE observation_generation_jobs
        SET status = 'queued',
            locked_at = NULL,
            locked_by = NULL,
            failed_at = NULL,
            cancelled_at = NULL,
            completed_at = NULL,
            last_error = NULL,
            attempts = LEAST(attempts, max_attempts - 1),
            payload = $4::jsonb,
            updated_at = now()
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [id, row.project_id, teamId, JSON.stringify(newPayload)],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    // Append lifecycle event so the audit chain mirrors the lifecycle tracker.
    const eventsRepo = new PostgresObservationGenerationJobEventsRepository(this.options.pool);
    await eventsRepo.append({
      generationJobId: id,
      projectId: row.project_id,
      teamId,
      eventType: 'queued',
      statusAfter: 'queued',
      attempt: (updatedRow as { attempts: number }).attempts,
      details: {
        source: 'operator_retry',
        requestId: req.requestId ?? null,
        retriedCount,
      },
    });

    // Re-enqueue to BullMQ. If the queue is unavailable we leave the row in
    // queued state and reconciliation will publish it on next startup —
    // never lie about "enqueued" when we couldn't publish.
    const queue = this.resolveEventQueueForRetry(updatedRow as { source_type: string });
    if (queue && updatedRow) {
      try {
        const bullmqJobId = (updatedRow as { bullmq_job_id: string | null }).bullmq_job_id;
        if (bullmqJobId) {
          // Best effort remove first so a terminal-state slot doesn't block.
          try { await queue.remove(bullmqJobId); } catch { /* terminal slot may be missing — ok */ }
          await queue.add(bullmqJobId, retryBullmqPayload as never);
        }
      } catch (error) {
        logger.warn('SYSTEM', 'failed to re-enqueue generation job on operator retry', {
          jobId: id,
          requestId: req.requestId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const refreshed = await repo.getByIdForScope({ id, projectId: row.project_id, teamId });
    if (!refreshed) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    await this.auditWrite(req, 'generation_job.retried_by_operator', refreshed.id, refreshed.projectId, {
      previousStatus: current.status,
      currentStatus: refreshed.status,
      retriedCount,
      requestId: req.requestId ?? null,
    });

    return { job: refreshed, retriedCount, alreadyQueued: false };
  }

  // Phase 12 — operator cancel. Idempotent: a job already in `cancelled`
  // status is a no-op. Active processing rows are still cancelled but the
  // running worker is allowed to finish; Phase 11's lockOutbox guard
  // re-checks Postgres status before any side effect, so a cancelled job
  // will not produce observations even if the BullMQ delivery raced.
  private async cancelGenerationJob(
    req: Request,
    res: Response,
    id: string,
    teamId: string,
  ): Promise<{ job: PostgresObservationGenerationJob; alreadyCancelled: boolean } | null> {
    if (!id) {
      res.status(400).json({ error: 'ValidationError', message: 'job id required' });
      return null;
    }
    const lookup = await this.options.pool.query(
      `SELECT * FROM observation_generation_jobs WHERE id = $1 AND team_id = $2`,
      [id, teamId],
    );
    const row = lookup.rows[0] as undefined | { project_id: string };
    if (!row) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }
    if (req.authContext?.projectId && req.authContext.projectId !== row.project_id) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }
    const repo = new PostgresObservationGenerationJobRepository(this.options.pool);
    const current = await repo.getByIdForScope({ id, projectId: row.project_id, teamId });
    if (!current) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }
    if (current.status === 'cancelled') {
      await this.auditWrite(req, 'generation_job.cancelled_by_operator', current.id, current.projectId, {
        outcome: 'noop_already_cancelled',
        requestId: req.requestId ?? null,
      });
      return { job: current, alreadyCancelled: true };
    }
    if (current.status === 'completed') {
      res.status(409).json({
        error: 'Conflict',
        message: 'Generation job already completed; cannot cancel',
      });
      return null;
    }

    const updateResult = await this.options.pool.query(
      `
        UPDATE observation_generation_jobs
        SET status = 'cancelled',
            cancelled_at = now(),
            updated_at = now()
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [id, row.project_id, teamId],
    );
    const updatedRow = updateResult.rows[0];
    if (!updatedRow) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    const eventsRepo = new PostgresObservationGenerationJobEventsRepository(this.options.pool);
    await eventsRepo.append({
      generationJobId: id,
      projectId: row.project_id,
      teamId,
      eventType: 'cancelled',
      statusAfter: 'cancelled',
      attempt: (updatedRow as { attempts: number }).attempts,
      details: {
        source: 'operator_cancel',
        requestId: req.requestId ?? null,
      },
    });

    // Best-effort BullMQ removal so a delayed/waiting job stops occupying
    // the slot. Active jobs cannot be removed; the lockOutbox status check
    // (Phase 11) is the authoritative side-effect guard.
    const queue = this.resolveEventQueueForRetry(updatedRow as { source_type: string });
    if (queue) {
      const bullmqJobId = (updatedRow as { bullmq_job_id: string | null }).bullmq_job_id;
      if (bullmqJobId) {
        try { await queue.remove(bullmqJobId); } catch {
          // Active jobs can't be removed; that's fine — Postgres status is canonical.
        }
      }
    }

    const refreshed = await repo.getByIdForScope({ id, projectId: row.project_id, teamId });
    if (!refreshed) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    await this.auditWrite(req, 'generation_job.cancelled_by_operator', refreshed.id, refreshed.projectId, {
      previousStatus: current.status,
      currentStatus: refreshed.status,
      requestId: req.requestId ?? null,
    });

    return { job: refreshed, alreadyCancelled: false };
  }

  // Phase 12 — pick the right queue lane for a given source_type so retries
  // and cancels can publish to the same lane the original ingest used.
  private resolveEventQueueForRetry(row: { source_type: string }):
    { add: (jobId: string, payload: unknown, options?: unknown) => Promise<unknown>; remove: (jobId: string) => Promise<void> } | null {
    if (row.source_type === 'session_summary') {
      const queue = this.resolveSummaryQueue();
      if (!queue) return null;
      return queue as never;
    }
    const queue = this.resolveEventQueue();
    if (!queue) return null;
    return queue as never;
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
  // Phase 12 — payload is OPTIONAL because the SELECT may omit it, and
  // serializers strip it unless the caller explicitly opted in.
  payload?: unknown;
}

const SOURCE_TYPE_VALUES = new Set(['agent_event', 'session_summary', 'observation_reindex']);

function parseGenericJobListingQuery(req: Request): {
  status: string | null;
  sourceType: string | null;
  limit: number;
  offset: number;
  since: Date | null;
} {
  const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const status = statusRaw && JOB_LIST_STATUS_VALUES.has(statusRaw) ? statusRaw : null;
  const sourceTypeRaw = typeof req.query.source_type === 'string' ? req.query.source_type.trim() : '';
  const sourceType = sourceTypeRaw && SOURCE_TYPE_VALUES.has(sourceTypeRaw) ? sourceTypeRaw : null;
  const limit = clampInt(req.query.limit, JOB_LIST_DEFAULT_LIMIT, 1, JOB_LIST_MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const sinceRaw = typeof req.query.since === 'string' ? req.query.since.trim() : '';
  let since: Date | null = null;
  if (sinceRaw) {
    const parsed = new Date(sinceRaw);
    if (!Number.isNaN(parsed.getTime())) since = parsed;
  }
  return { status, sourceType, limit, offset, since };
}

function extractRetriedCount(payload: Record<string, unknown> | null | undefined): number {
  if (!payload || typeof payload !== 'object') return 0;
  const value = (payload as { retried_count?: unknown }).retried_count;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
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

function serializeJobListEntry(
  row: JobListRow,
  options: { includePayload?: boolean } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
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
  // Phase 12 — payload is sensitive (it may carry full event payloads
  // under `agent_events.payload`). Strip by default; only include when the
  // caller explicitly opted in via `?include=payload`. The route handler
  // gates that flag on admin scope BEFORE reaching here.
  if (options.includePayload && row.payload && typeof row.payload === 'object') {
    base.payload = row.payload;
  }
  return base;
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
    'generation_job.retried_by_operator': 'observation_generation_job',
    'generation_job.cancelled_by_operator': 'observation_generation_job',
    'generation_job.stalled': 'observation_generation_job',
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

// `?wait=true` polls the outbox row until it reaches a terminal status
// (or hits WAIT_TIMEOUT_MS). The serialized payload reports `status`,
// `attempts`, and `lastError`-equivalents on the outbox row itself; the
// caller queries the observations endpoints to fetch the actual content.
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
