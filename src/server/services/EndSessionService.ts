// SPDX-License-Identifier: Apache-2.0

// Shared session-end + summary-job path used by both `/v1/sessions/:id/end`
// (canonical) and `src/server/compat/SessionsSummarizeAdapter.ts` (legacy
// translator). Both call sites must produce identical Postgres state and
// queue effects: ended_at idempotency, exactly one outbox row per session
// summary, deterministic BullMQ job id.
//
// This module MUST NOT import from src/services/worker/* — Phase 9 keeps
// the compat shim coupled to Server beta core only.

import {
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
  type PostgresObservationGenerationJob,
} from '../../storage/postgres/generation-jobs.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { withPostgresTransaction } from '../../storage/postgres/pool.js';
import {
  PostgresServerSessionsRepository,
  type PostgresServerSession,
} from '../../storage/postgres/server-sessions.js';
import { logger } from '../../utils/logger.js';
import { buildSummaryJobId, buildSummaryJobPayload } from '../runtime/SessionGenerationPolicy.js';
import type { GenerateSessionSummaryJob } from '../jobs/types.js';
import type { EnqueueOutcome, EventQueueLike } from './IngestEventsService.js';
import { newId } from '../../storage/postgres/utils.js';

const SUMMARY_JOB_TYPE = 'observation_generate_session_summary';

export interface EndSessionServiceOptions {
  pool: PostgresPool;
  resolveSummaryQueue: () => EventQueueLike | null;
}

export interface EndSessionResult {
  session: PostgresServerSession | null;
  outbox: PostgresObservationGenerationJob | null;
  enqueueState: EnqueueOutcome;
}

export interface EndSessionInput {
  sessionId: string;
  projectId: string;
  teamId: string;
  source?: string;
  // Phase 11 — identity context propagated into the BullMQ summary payload.
  apiKeyId?: string | null;
  actorId?: string | null;
  sourceAdapter?: string | null;
}

export class EndSessionService {
  constructor(private readonly options: EndSessionServiceOptions) {}

  async end(input: EndSessionInput): Promise<EndSessionResult> {
    const source = input.source ?? 'http_post_v1_sessions_end';

    const txResult = await withPostgresTransaction(this.options.pool, async (client) => {
      const sessionsRepo = new PostgresServerSessionsRepository(client);
      const ended = await sessionsRepo.endSession({
        id: input.sessionId,
        projectId: input.projectId,
        teamId: input.teamId,
      });
      if (!ended) {
        return {
          session: null as PostgresServerSession | null,
          outbox: null as PostgresObservationGenerationJob | null,
        };
      }
      const jobsRepo = new PostgresObservationGenerationJobRepository(client);
      const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
      // Persist the BullMQ payload at create-time so reconciliation and
      // operator retry can re-enqueue a payload that passes the worker's
      // assertServerGenerationJobPayload validation.
      const outboxId = newId();
      const summaryPayload = buildSummaryJobPayload({
        serverSessionId: ended.id,
        teamId: ended.teamId,
        projectId: ended.projectId,
        generationJobId: outboxId,
        apiKeyId: input.apiKeyId ?? null,
        actorId: input.actorId ?? null,
        sourceAdapter: input.sourceAdapter ?? null,
      });
      const outbox = await jobsRepo.create({
        id: outboxId,
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
        payload: summaryPayload as unknown as Record<string, unknown>,
      });
      await eventsLogRepo.append({
        generationJobId: outbox.id,
        projectId: outbox.projectId,
        teamId: outbox.teamId,
        eventType: 'queued',
        statusAfter: outbox.status,
        attempt: outbox.attempts,
        details: { source },
      });
      return { session: ended, outbox };
    });

    if (!txResult.session || !txResult.outbox) {
      return { session: txResult.session, outbox: null, enqueueState: 'skipped' };
    }
    const enqueueState = await this.publishSummaryJob(txResult.session.id, txResult.outbox, input);
    return { session: txResult.session, outbox: txResult.outbox, enqueueState };
  }

  private async publishSummaryJob(
    serverSessionId: string,
    outbox: PostgresObservationGenerationJob,
    input: EndSessionInput,
  ): Promise<'enqueued' | 'queued_only'> {
    const queue = this.options.resolveSummaryQueue();
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
      apiKeyId: input.apiKeyId ?? null,
      actorId: input.actorId ?? null,
      sourceAdapter: input.sourceAdapter ?? null,
    });
    try {
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
}
