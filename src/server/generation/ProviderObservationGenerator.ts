// SPDX-License-Identifier: Apache-2.0

import type { Job } from 'bullmq';
import { logger } from '../../utils/logger.js';
import { PostgresAgentEventsRepository } from '../../storage/postgres/agent-events.js';
import { PostgresObservationGenerationJobRepository } from '../../storage/postgres/generation-jobs.js';
import { PostgresProjectsRepository } from '../../storage/postgres/projects.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresObservationGenerationJob } from '../../storage/postgres/generation-jobs.js';
import type { ServerGenerationJobPayload } from '../jobs/types.js';
import { ServerClassifiedProviderError } from './providers/shared/error-classification.js';
import type { ServerGenerationProvider } from './providers/shared/types.js';
import {
  markGenerationFailed,
  processGeneratedResponse,
  type ProcessGeneratedResponseOutcome,
} from './processGeneratedResponse.js';

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
    const payload = job.data;
    const correlationId = `bullmq:${job.id ?? '?'}`;

    if (payload.kind !== 'event' && payload.kind !== 'event-batch') {
      logger.warn('SYSTEM', 'unsupported job kind for ProviderObservationGenerator', {
        correlationId,
        kind: payload.kind,
      });
      throw new Error(`unsupported job kind: ${payload.kind}`);
    }

    const fresh = await this.lockOutbox(payload.generation_job_id, payload.team_id, payload.project_id);
    if (!fresh) {
      logger.info('SYSTEM', 'job no longer exists or is in terminal status; nothing to do', {
        correlationId,
        generationJobId: payload.generation_job_id,
      });
      return { jobId: payload.generation_job_id, status: 'completed', observationCount: 0 };
    }

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

      const outcome: ProcessGeneratedResponseOutcome = await processGeneratedResponse({
        pool: this.options.pool,
        job: fresh,
        rawText: result.rawText,
        modelId: result.modelId,
        providerLabel: result.providerLabel,
        ...(this.options.workerId !== undefined ? { workerId: this.options.workerId } : {}),
      });

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
      // Another worker likely picked this up. Stale-lock recovery is a
      // separate concern (Phase 3 reconciliation owns it). Here we just
      // proceed and let processGeneratedResponse's terminal-status guard
      // collapse the duplicate.
      return current;
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
    if (job.sourceType !== 'agent_event') {
      return [];
    }

    type Event = NonNullable<Awaited<ReturnType<PostgresAgentEventsRepository['getByIdForScope']>>>;

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
