// SPDX-License-Identifier: Apache-2.0

import type { Application, Request, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import type { RouteHandler } from '../../../services/server/Server.js';
import { CreateAgentEventSchema } from '../../../core/schemas/agent-event.js';
import type { PostgresPool } from '../../../storage/postgres/pool.js';
import { withPostgresTransaction } from '../../../storage/postgres/pool.js';
import {
  PostgresAgentEventsRepository,
  type CreatePostgresAgentEventInput,
  type PostgresAgentEvent,
} from '../../../storage/postgres/agent-events.js';
import {
  PostgresObservationGenerationJobRepository,
  PostgresObservationGenerationJobEventsRepository,
  type PostgresObservationGenerationJob,
} from '../../../storage/postgres/generation-jobs.js';
import { PostgresAuthRepository } from '../../../storage/postgres/auth.js';
import { logger } from '../../../utils/logger.js';
import { requirePostgresServerAuth } from '../../middleware/postgres-auth.js';
import type { ActiveServerBetaQueueManager } from '../../runtime/ActiveServerBetaQueueManager.js';
import type { ServerBetaQueueManager } from '../../runtime/types.js';
import { buildServerJobId } from '../../jobs/job-id.js';
import type { GenerateSessionSummaryJob } from '../../jobs/types.js';
import { PostgresServerSessionsRepository } from '../../../storage/postgres/server-sessions.js';
import {
  buildEnqueueEventDecision,
  buildSummaryJobId,
  buildSummaryJobPayload,
  resolveSessionGenerationPolicy,
  scheduleDebouncedEventJob,
  type ServerSessionGenerationPolicy,
} from '../../runtime/SessionGenerationPolicy.js';

const EVENT_JOB_TYPE = 'observation_generate_for_event';
const SUMMARY_JOB_TYPE = 'observation_generate_session_summary';
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
  constructor(private readonly options: ServerV1PostgresRoutesOptions) {}

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
      try {
        const txResult = await withPostgresTransaction(this.options.pool, async (client) => {
          const eventsRepo = new PostgresAgentEventsRepository(client);
          const insertedEvent = await eventsRepo.create(insertInput);

          if (!generate) {
            return { insertedEvent, insertedOutbox: null as PostgresObservationGenerationJob | null };
          }

          const jobsRepo = new PostgresObservationGenerationJobRepository(client);
          const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
          const insertedOutbox = await jobsRepo.create({
            projectId: insertedEvent.projectId,
            teamId: insertedEvent.teamId,
            sourceType: 'agent_event',
            sourceId: insertedEvent.id,
            agentEventId: insertedEvent.id,
            serverSessionId: insertedEvent.serverSessionId,
            jobType: EVENT_JOB_TYPE,
            bullmqJobId: buildEventBullmqJobId(insertedEvent),
          });
          await eventsLogRepo.append({
            generationJobId: insertedOutbox.id,
            projectId: insertedOutbox.projectId,
            teamId: insertedOutbox.teamId,
            eventType: 'queued',
            statusAfter: insertedOutbox.status,
            attempt: insertedOutbox.attempts,
            details: { source: 'http_post_v1_events' },
          });
          return { insertedEvent, insertedOutbox };
        });
        event = txResult.insertedEvent;
        outbox = txResult.insertedOutbox;
      } catch (error) {
        this.handleDbError(error, res, 'event.write');
        return;
      }

      await this.auditWrite(req, 'event.write', event.id, event.projectId);

      // Enqueue AFTER commit. Failure to enqueue leaves the outbox row in
      // `queued` state and Phase 3 startup reconciliation re-publishes it.
      let enqueueState: 'enqueued' | 'queued_only' | 'skipped' = 'skipped';
      if (outbox) {
        enqueueState = await this.enqueueEventJob(event, outbox);
      }

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
      try {
        inserted = await withPostgresTransaction(this.options.pool, async (client) => {
          const eventsRepo = new PostgresAgentEventsRepository(client);
          const jobsRepo = new PostgresObservationGenerationJobRepository(client);
          const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
          const acc: { event: PostgresAgentEvent; outbox: PostgresObservationGenerationJob | null }[] = [];
          for (const input of inputs) {
            const event = await eventsRepo.create(input);
            if (!generate) {
              acc.push({ event, outbox: null });
              continue;
            }
            const outbox = await jobsRepo.create({
              projectId: event.projectId,
              teamId: event.teamId,
              sourceType: 'agent_event',
              sourceId: event.id,
              agentEventId: event.id,
              serverSessionId: event.serverSessionId,
              jobType: EVENT_JOB_TYPE,
              bullmqJobId: buildEventBullmqJobId(event),
            });
            await eventsLogRepo.append({
              generationJobId: outbox.id,
              projectId: outbox.projectId,
              teamId: outbox.teamId,
              eventType: 'queued',
              statusAfter: outbox.status,
              attempt: outbox.attempts,
              details: { source: 'http_post_v1_events_batch' },
            });
            acc.push({ event, outbox });
          }
          return acc;
        });
      } catch (error) {
        this.handleDbError(error, res, 'event.batch_write');
        return;
      }

      await this.auditWrite(req, 'event.batch_write', null, null);

      // Per-item enqueue after commit. Each failed enqueue leaves its row in
      // `queued` state for startup reconciliation; we never roll back the
      // committed batch on a transport error.
      const enqueueResults: ('enqueued' | 'queued_only' | 'skipped')[] = await Promise.all(
        inserted.map(async ({ event, outbox }) => {
          if (!outbox) return 'skipped';
          return this.enqueueEventJob(event, outbox);
        }),
      );

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

      res.json({
        eventId: eventRow.id,
        observations: obsResult.rows.map(serializeObservationWithSource),
      });
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

      let endedSession: Awaited<ReturnType<PostgresServerSessionsRepository['endSession']>>;
      let summaryOutbox: PostgresObservationGenerationJob | null = null;
      try {
        const txResult = await withPostgresTransaction(this.options.pool, async (client) => {
          const sessionsRepo = new PostgresServerSessionsRepository(client);
          const ended = await sessionsRepo.endSession({
            id,
            projectId: row.project_id,
            teamId,
          });
          if (!ended) {
            return { ended: null as Awaited<ReturnType<PostgresServerSessionsRepository['endSession']>>, outbox: null as PostgresObservationGenerationJob | null };
          }
          const jobsRepo = new PostgresObservationGenerationJobRepository(client);
          const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
          const outbox = await jobsRepo.create({
            projectId: ended.projectId,
            teamId: ended.teamId,
            sourceType: 'session_summary',
            sourceId: ended.id,
            serverSessionId: ended.id,
            jobType: SUMMARY_JOB_TYPE,
            bullmqJobId: buildSummaryJobId({
              serverSessionId: ended.id,
              teamId: ended.teamId,
              projectId: ended.projectId,
            }),
          });
          // Append a 'queued' lifecycle event only when this is the first time
          // the outbox row is observed. ON CONFLICT in jobs.create already
          // collapses re-ends to the same row id, but a duplicate lifecycle
          // event is harmless and observable.
          await eventsLogRepo.append({
            generationJobId: outbox.id,
            projectId: outbox.projectId,
            teamId: outbox.teamId,
            eventType: 'queued',
            statusAfter: outbox.status,
            attempt: outbox.attempts,
            details: { source: 'http_post_v1_sessions_end' },
          });
          return { ended, outbox };
        });
        endedSession = txResult.ended;
        summaryOutbox = txResult.outbox;
      } catch (error) {
        this.handleDbError(error, res, 'session.end');
        return;
      }

      if (!endedSession) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }

      await this.auditWrite(req, 'session.end', endedSession.id, endedSession.projectId);

      let enqueueState: 'enqueued' | 'queued_only' | 'skipped' = 'skipped';
      if (summaryOutbox) {
        enqueueState = await this.enqueueSummaryJob(endedSession.id, summaryOutbox);
      }

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
  }

  private async enqueueEventJob(
    event: PostgresAgentEvent,
    outbox: PostgresObservationGenerationJob,
  ): Promise<'enqueued' | 'queued_only'> {
    const queue = this.resolveEventQueue();
    if (!queue) {
      return 'queued_only';
    }
    const policyOptions: { policy?: ServerSessionGenerationPolicy; debounceWindowMs?: number } = {};
    if (this.options.sessionPolicy !== undefined) {
      policyOptions.policy = this.options.sessionPolicy;
    }
    if (this.options.sessionDebounceWindowMs !== undefined) {
      policyOptions.debounceWindowMs = this.options.sessionDebounceWindowMs;
    }
    const decision = buildEnqueueEventDecision({ event, outbox }, policyOptions);
    if (!decision.shouldEnqueue) {
      // end-of-session policy: outbox row stays `queued`; summary path will
      // fan out generation when /v1/sessions/:id/end fires.
      return 'queued_only';
    }
    try {
      await scheduleDebouncedEventJob(queue, decision);
      // We intentionally do NOT append a second 'enqueued' job event row here
      // to avoid a second DB round-trip on the hot path. The Phase 3 worker
      // surface treats absence of a transport-side echo as expected when the
      // outbox row is transitioned by the consumer side.
      return 'enqueued';
    } catch (error) {
      logger.warn('SYSTEM', 'failed to publish event generation job to BullMQ', {
        outboxId: outbox.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'queued_only';
    }
  }

  private async enqueueSummaryJob(
    serverSessionId: string,
    outbox: PostgresObservationGenerationJob,
  ): Promise<'enqueued' | 'queued_only'> {
    const queue = this.resolveSummaryQueue();
    if (!queue) {
      return 'queued_only';
    }
    const jobId = outbox.bullmqJobId ?? buildSummaryJobId({
      serverSessionId,
      teamId: outbox.teamId,
      projectId: outbox.projectId,
    });
    const payload: GenerateSessionSummaryJob = buildSummaryJobPayload({
      serverSessionId,
      teamId: outbox.teamId,
      projectId: outbox.projectId,
      generationJobId: outbox.id,
    });
    try {
      // Re-ending an already-summarized session collapses to the same
      // deterministic jobId. BullMQ add(jobId, ...) is idempotent — the
      // existing job is returned without duplicate work.
      await queue.add(jobId, payload);
      return 'enqueued';
    } catch (error) {
      logger.warn('SYSTEM', 'failed to publish summary generation job to BullMQ', {
        outboxId: outbox.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'queued_only';
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
  ): Promise<void> {
    try {
      const repo = new PostgresAuthRepository(this.options.pool);
      await repo.createAuditLog({
        teamId: req.authContext?.teamId ?? null,
        projectId: projectId ?? req.authContext?.projectId ?? null,
        actorId: null,
        apiKeyId: req.authContext?.apiKeyId ?? null,
        action,
        resourceType: action.split('.')[0] ?? 'unknown',
        resourceId: targetId,
      });
    } catch (error) {
      logger.warn('SYSTEM', 'audit log insert failed', {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

function buildEventBullmqJobId(event: PostgresAgentEvent): string {
  return buildServerJobId({
    kind: 'event',
    team_id: event.teamId,
    project_id: event.projectId,
    source_type: 'agent_event',
    source_id: event.id,
  });
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
