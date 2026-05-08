// SPDX-License-Identifier: Apache-2.0

import type { Job } from 'bullmq';
import { logger } from '../../utils/logger.js';
import { PostgresAgentEventsRepository } from '../../storage/postgres/agent-events.js';
import { PostgresObservationGenerationJobRepository } from '../../storage/postgres/generation-jobs.js';
import { PostgresProjectsRepository } from '../../storage/postgres/projects.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresObservationGenerationJob } from '../../storage/postgres/generation-jobs.js';
import {
  assertServerGenerationJobPayload,
  ServerGenerationJobPayloadValidationError,
  type ServerGenerationJobPayload,
} from '../jobs/types.js';
import { ServerClassifiedProviderError } from './providers/shared/error-classification.js';
import type { ServerGenerationProvider } from './providers/shared/types.js';
import {
  markGenerationFailed,
  processGeneratedResponse,
  processSessionSummaryResponse,
  type ProcessGeneratedResponseOutcome,
} from './processGeneratedResponse.js';
import { PostgresServerSessionsRepository } from '../../storage/postgres/server-sessions.js';

// Phase 11 — sentinel exception class so the worker can distinguish
// scope-violation/revoked-key failures from generic processor errors and
// audit them under the right action. Marked non-retryable: an attacker who
// tampered with a payload should never be retried into the queue.
export class ServerGenerationScopeViolationError extends Error {
  readonly reason: 'scope_mismatch' | 'revoked_key';
  constructor(reason: 'scope_mismatch' | 'revoked_key', message: string) {
    super(message);
    this.reason = reason;
  }
}

// ProviderObservationGenerator is the BullMQ Worker processor for server-beta
// observation generation. It does the following on every job invocation:
//
//   1. Reload the Postgres outbox row and the source agent_events row.
//   2. Lock the outbox by transitioning queued -> processing.
//   3. Call the provider with a fully-reloaded ServerGenerationContext.
//      BullMQ payload data is advisory only.
//   4. Hand the raw response to processGeneratedResponse, which persists +
//      links + advances outbox in one Postgres transaction.
//   5. On provider/parse error, route through markGenerationFailed which
//      decides retry vs final failure based on attempt count + error class.
//
// Anti-pattern guards verified at the boundary:
//   - no imports from src/services/worker/*
//   - no use of WorkerRef / ActiveSession / SessionStore
//   - no assumption of Claude Code transcript shape

export interface ProviderObservationGeneratorOptions {
  pool: PostgresPool;
  provider: ServerGenerationProvider;
  workerId?: string;
}

export class ProviderObservationGenerator {
  constructor(private readonly options: ProviderObservationGeneratorOptions) {}

  /**
   * Worker entrypoint. Returns a small JSON summary on success so BullMQ's
   * completed-state telemetry has something to inspect, but Postgres remains
   * canonical authority.
   */
  async process(
    job: Job<ServerGenerationJobPayload>,
  ): Promise<{ jobId: string; status: 'completed'; observationCount: number }> {
    const correlationId = `bullmq:${job.id ?? '?'}`;
    // Phase 12 — pivot id captured up front so every log line in this
    // dispatch carries the same identifier whether or not we manage to
    // load the canonical row. requestId comes from payload (HTTP middleware).
    const payloadRequestId = (job.data as { request_id?: string | null } | undefined)?.request_id ?? null;

    // Phase 11 — validate the BullMQ payload against the discriminated-union
    // schema BEFORE doing anything else. A malformed payload (missing
    // team_id, project_id, generation_job_id, etc.) means the enqueue path
    // bypassed the boundary contract; we refuse to run it. Throwing surfaces
    // it on BullMQ's failed list with a clear message.
    let payload: ServerGenerationJobPayload;
    try {
      payload = assertServerGenerationJobPayload(job.data);
    } catch (error) {
      if (error instanceof ServerGenerationJobPayloadValidationError) {
        logger.error('SYSTEM', 'rejecting malformed job payload at execution', {
          correlationId,
          issues: error.issues,
        });
      }
      throw error;
    }

    if (payload.kind !== 'event' && payload.kind !== 'event-batch' && payload.kind !== 'summary') {
      logger.warn('SYSTEM', 'unsupported job kind for ProviderObservationGenerator', {
        correlationId,
        kind: payload.kind,
      });
      throw new Error(`unsupported job kind: ${payload.kind}`);
    }

    // Phase 11 — anti-bypass guard. We MUST NOT trust BullMQ payload data
    // for tenant scope. Reload the canonical outbox row keyed by id only
    // (no scope filter), then compare its team_id/project_id to the
    // payload's. A mismatch indicates payload tampering or a programmer
    // bug; either way we audit and refuse.
    const candidate = await this.loadCanonicalOutbox(payload.generation_job_id);
    if (!candidate) {
      logger.info('SYSTEM', 'job row not found by id; nothing to do', {
        correlationId,
        generationJobId: payload.generation_job_id,
      });
      return { jobId: payload.generation_job_id, status: 'completed', observationCount: 0 };
    }
    if (candidate.teamId !== payload.team_id || candidate.projectId !== payload.project_id) {
      const violation = new ServerGenerationScopeViolationError(
        'scope_mismatch',
        `BullMQ payload team/project does not match outbox row (jobId=${payload.generation_job_id})`,
      );
      await this.auditScopeViolation(payload, candidate, violation, correlationId);
      // Tag the row as failed so subsequent retries do not pick it up.
      await markGenerationFailed({
        pool: this.options.pool,
        job: candidate,
        reason: violation.message,
        classification: 'scope_mismatch',
        retryable: false,
        ...(this.options.workerId !== undefined ? { workerId: this.options.workerId } : {}),
      });
      throw violation;
    }

    // Phase 11 — revocation check. If the api_key that initiated this job
    // was revoked between enqueue and execution, do not generate. Audit
    // and fail without retry.
    if (payload.api_key_id) {
      const revoked = await this.isApiKeyRevoked(payload.api_key_id);
      if (revoked) {
        const violation = new ServerGenerationScopeViolationError(
          'revoked_key',
          `api key ${payload.api_key_id} is revoked; refusing to generate for outbox ${candidate.id}`,
        );
        await this.auditRevokedKey(payload, candidate, violation, correlationId);
        await markGenerationFailed({
          pool: this.options.pool,
          job: candidate,
          reason: violation.message,
          classification: 'revoked_key',
          retryable: false,
          ...(this.options.workerId !== undefined ? { workerId: this.options.workerId } : {}),
        });
        throw violation;
      }
    }

    const fresh = await this.lockOutbox(payload.generation_job_id, payload.team_id, payload.project_id);
    if (!fresh) {
      logger.info('SYSTEM', 'job no longer exists or is in terminal status; nothing to do', {
        correlationId,
        generationJobId: payload.generation_job_id,
      });
      return { jobId: payload.generation_job_id, status: 'completed', observationCount: 0 };
    }

    // Phase 11 — emit "processing started" audit so we have a row even if
    // the provider crashes before completion.
    // Phase 12 — log+audit carry the same job_id / request_id so support
    // can pivot from BullMQ id -> outbox id -> originating HTTP request.
    logger.info('SYSTEM', `[generation] job locked for processing`, {
      correlationId,
      jobId: fresh.id,
      bullmqJobId: job.id ?? null,
      requestId: payloadRequestId,
      sourceType: fresh.sourceType,
      attempt: fresh.attempts,
    });
    await this.auditEvent({
      teamId: fresh.teamId,
      projectId: fresh.projectId,
      apiKeyId: payload.api_key_id,
      actorId: payload.actor_id,
      action: 'generation_job.processing',
      resourceId: fresh.id,
      details: {
        sourceType: fresh.sourceType,
        sourceId: fresh.sourceId,
        sourceAdapter: payload.source_adapter,
        attempt: fresh.attempts,
        correlationId,
        requestId: payloadRequestId,
      },
    });

    try {
      const events = await this.loadEvents(fresh, payload);
      const project = await this.loadProject(fresh);

      const result = await this.options.provider.generate({
        job: fresh,
        events,
        project: {
          projectId: fresh.projectId,
          teamId: fresh.teamId,
          serverSessionId: fresh.serverSessionId,
          projectName: project?.name ?? null,
        },
      });

      const persistInput = {
        pool: this.options.pool,
        job: fresh,
        rawText: result.rawText,
        modelId: result.modelId,
        providerLabel: result.providerLabel,
        // Phase 11 — flow identity context from BullMQ payload into the
        // persistence layer so observations and audit rows carry the same
        // generation_job_id reference back through to the original API key.
        apiKeyId: payload.api_key_id,
        actorId: payload.actor_id,
        sourceAdapter: payload.source_adapter,
        ...(this.options.workerId !== undefined ? { workerId: this.options.workerId } : {}),
      };
      const outcome: ProcessGeneratedResponseOutcome = fresh.sourceType === 'session_summary'
        ? await processSessionSummaryResponse(persistInput)
        : await processGeneratedResponse(persistInput);

      if (outcome.kind === 'parse_error') {
        await markGenerationFailed({
          pool: this.options.pool,
          job: fresh,
          reason: outcome.reason,
          classification: 'parse_error',
          retryable: false,
          ...(this.options.workerId !== undefined ? { workerId: this.options.workerId } : {}),
        });
        throw new Error(`generation parse error: ${outcome.reason}`);
      }

      logger.info('SYSTEM', 'generation completed', {
        correlationId,
        jobId: outcome.jobId,
        bullmqJobId: job.id ?? null,
        requestId: payloadRequestId,
        observationCount: outcome.observations.length,
        privateContentDetected: outcome.privateContentDetected,
      });

      return {
        jobId: outcome.jobId,
        status: 'completed',
        observationCount: outcome.observations.length,
      };
    } catch (error) {
      const classified = error instanceof ServerClassifiedProviderError ? error : null;
      const retryable = classified
        ? classified.kind === 'transient' || classified.kind === 'rate_limit'
        : false;
      await markGenerationFailed({
        pool: this.options.pool,
        job: fresh,
        reason: error instanceof Error ? error.message : String(error),
        classification: classified?.kind ?? 'unknown',
        retryable,
        ...(this.options.workerId !== undefined ? { workerId: this.options.workerId } : {}),
      });
      throw error;
    }
  }

  // Phase 11 — load the outbox row by id WITHOUT a scope filter so we can
  // compare its team_id/project_id to the BullMQ payload as a tampering
  // detector. Authoritative scope decisions still come from this row, NEVER
  // from the BullMQ payload.
  private async loadCanonicalOutbox(jobId: string): Promise<PostgresObservationGenerationJob | null> {
    const result = await this.options.pool.query<{
      id: string;
      project_id: string;
      team_id: string;
      agent_event_id: string | null;
      source_type: 'agent_event' | 'session_summary' | 'observation_reindex';
      source_id: string;
      server_session_id: string | null;
      job_type: string;
      status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
      idempotency_key: string;
      bullmq_job_id: string | null;
      attempts: number;
      max_attempts: number;
      next_attempt_at: Date | null;
      locked_at: Date | null;
      locked_by: string | null;
      completed_at: Date | null;
      failed_at: Date | null;
      cancelled_at: Date | null;
      last_error: unknown;
      payload: unknown;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT * FROM observation_generation_jobs WHERE id = $1',
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      teamId: row.team_id,
      agentEventId: row.agent_event_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      serverSessionId: row.server_session_id,
      jobType: row.job_type,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      bullmqJobId: row.bullmq_job_id,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAtEpoch: row.next_attempt_at?.getTime() ?? null,
      lockedAtEpoch: row.locked_at?.getTime() ?? null,
      lockedBy: row.locked_by,
      completedAtEpoch: row.completed_at?.getTime() ?? null,
      failedAtEpoch: row.failed_at?.getTime() ?? null,
      cancelledAtEpoch: row.cancelled_at?.getTime() ?? null,
      lastError: row.last_error && typeof row.last_error === 'object'
        ? (row.last_error as Record<string, unknown>)
        : null,
      payload: row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
      createdAtEpoch: row.created_at.getTime(),
      updatedAtEpoch: row.updated_at.getTime(),
    };
  }

  private async isApiKeyRevoked(apiKeyId: string): Promise<boolean> {
    const result = await this.options.pool.query<{ revoked_at: Date | null; expires_at: Date | null }>(
      'SELECT revoked_at, expires_at FROM api_keys WHERE id = $1',
      [apiKeyId],
    );
    const row = result.rows[0];
    if (!row) {
      // The key was deleted entirely. Treat as revoked.
      return true;
    }
    if (row.revoked_at) return true;
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) return true;
    return false;
  }

  private async auditScopeViolation(
    payload: ServerGenerationJobPayload,
    canonical: PostgresObservationGenerationJob,
    error: ServerGenerationScopeViolationError,
    correlationId: string,
  ): Promise<void> {
    logger.error('SYSTEM', 'BullMQ payload scope mismatch — refusing to generate', {
      correlationId,
      generationJobId: payload.generation_job_id,
      payloadTeamId: payload.team_id,
      payloadProjectId: payload.project_id,
      canonicalTeamId: canonical.teamId,
      canonicalProjectId: canonical.projectId,
    });
    await this.auditEvent({
      teamId: canonical.teamId,
      projectId: canonical.projectId,
      apiKeyId: payload.api_key_id,
      actorId: payload.actor_id,
      action: 'generation_job.scope_violation',
      resourceId: canonical.id,
      details: {
        reason: 'scope_mismatch',
        message: error.message,
        payloadTeamId: payload.team_id,
        payloadProjectId: payload.project_id,
        canonicalTeamId: canonical.teamId,
        canonicalProjectId: canonical.projectId,
        sourceAdapter: payload.source_adapter,
        correlationId,
      },
    });
  }

  private async auditRevokedKey(
    payload: ServerGenerationJobPayload,
    canonical: PostgresObservationGenerationJob,
    error: ServerGenerationScopeViolationError,
    correlationId: string,
  ): Promise<void> {
    logger.warn('SYSTEM', 'api key revoked between enqueue and execute — refusing to generate', {
      correlationId,
      generationJobId: payload.generation_job_id,
      apiKeyId: payload.api_key_id,
    });
    await this.auditEvent({
      teamId: canonical.teamId,
      projectId: canonical.projectId,
      apiKeyId: payload.api_key_id,
      actorId: payload.actor_id,
      action: 'generation_job.revoked_key',
      resourceId: canonical.id,
      details: {
        reason: 'revoked_key',
        message: error.message,
        sourceAdapter: payload.source_adapter,
        correlationId,
      },
    });
  }

  private async auditEvent(input: {
    teamId: string | null;
    projectId: string | null;
    apiKeyId: string | null;
    actorId: string | null;
    action: string;
    resourceId: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const repo = new PostgresAuthRepository(this.options.pool);
      await repo.createAuditLog({
        teamId: input.teamId,
        projectId: input.projectId,
        actorId: input.actorId,
        apiKeyId: input.apiKeyId,
        action: input.action,
        resourceType: 'observation_generation_job',
        resourceId: input.resourceId,
        details: input.details ?? {},
      });
    } catch (auditError) {
      logger.warn('SYSTEM', 'audit_log insert failed in ProviderObservationGenerator', {
        action: input.action,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
  }

  private async lockOutbox(
    jobId: string,
    teamId: string,
    projectId: string,
  ): Promise<PostgresObservationGenerationJob | null> {
    const repo = new PostgresObservationGenerationJobRepository(this.options.pool);
    const current = await repo.getByIdForScope({ id: jobId, projectId, teamId });
    if (!current) {
      return null;
    }
    if (current.status === 'completed' || current.status === 'cancelled' || current.status === 'failed') {
      return null;
    }
    if (current.status === 'processing') {
      // Another worker holds the lock — most commonly this fires when BullMQ
      // redelivers a stalled job to a second worker while the first is still
      // mid-`provider.generate()`. Returning the row here would cause both
      // workers to issue the (paid, rate-limited) external provider call,
      // and the persistence-level terminal-status guard only collapses the
      // duplicate after the call has already happened. Skip instead. If the
      // first worker truly died, `reconcileOnStartup` (and the next BullMQ
      // retry) will resurrect the row.
      logger.info('SYSTEM', 'generation job already in processing; skipping duplicate worker run', {
        jobId: current.id,
        lockedBy: current.lockedBy,
        lockedAtEpoch: current.lockedAtEpoch,
        attempts: current.attempts,
      });
      return null;
    }
    const transitioned = await repo.transitionStatus({
      id: current.id,
      projectId: current.projectId,
      teamId: current.teamId,
      status: 'processing',
      lockedBy: this.options.workerId ?? 'server-beta-worker',
    });
    return transitioned;
  }

  private async loadEvents(
    job: PostgresObservationGenerationJob,
    payload: ServerGenerationJobPayload,
  ): Promise<NonNullable<Awaited<ReturnType<PostgresAgentEventsRepository['getByIdForScope']>>>[]> {
    const repo = new PostgresAgentEventsRepository(this.options.pool);

    type Event = NonNullable<Awaited<ReturnType<PostgresAgentEventsRepository['getByIdForScope']>>>;

    if (job.sourceType === 'session_summary') {
      // Summary jobs feed the provider every event tied to the server_session
      // that hasn't already been collapsed into a completed event-generation
      // job. The session repo enforces tenant scope inside its WHERE clause.
      if (!job.serverSessionId) return [];
      const sessions = new PostgresServerSessionsRepository(this.options.pool);
      const events = await sessions.listUnprocessedEvents({
        serverSessionId: job.serverSessionId,
        projectId: job.projectId,
        teamId: job.teamId,
      });
      return events;
    }

    if (job.sourceType !== 'agent_event') {
      return [];
    }

    if (payload.kind === 'event') {
      const event = await repo.getByIdForScope({
        id: payload.agent_event_id,
        projectId: job.projectId,
        teamId: job.teamId,
      });
      return event ? [event] : [];
    }

    if (payload.kind === 'event-batch') {
      const out: Event[] = [];
      for (const id of payload.agent_event_ids) {
        const event = await repo.getByIdForScope({
          id,
          projectId: job.projectId,
          teamId: job.teamId,
        });
        if (event) out.push(event);
      }
      return out;
    }

    return [];
  }

  private async loadProject(job: PostgresObservationGenerationJob) {
    const repo = new PostgresProjectsRepository(this.options.pool);
    return await repo.getByIdForTeam(job.projectId, job.teamId);
  }
}
