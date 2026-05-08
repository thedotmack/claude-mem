// SPDX-License-Identifier: Apache-2.0

import type {
  PostgresObservationGenerationJob,
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository
} from '../../storage/postgres/generation-jobs.js';
import type { JsonObject } from '../../storage/postgres/utils.js';
import { logger } from '../../utils/logger.js';
import { buildServerJobId } from './job-id.js';
import type { ServerJobQueue } from './ServerJobQueue.js';
import {
  assertServerGenerationJobPayload,
  type GenerateObservationsForEventJob,
  type GenerateSessionSummaryJob,
  type ReindexObservationJob,
  type ServerGenerationJobKind,
} from './types.js';

// Postgres outbox is canonical history; BullMQ is the execution transport.
// Each outbox row corresponds to one observation_generation_jobs row, keyed
// by a deterministic BullMQ jobId so duplicate enqueues collapse on the
// transport side and dedup is enforced again by the row's idempotency_key.

export type SingleSourceJobPayload =
  | GenerateObservationsForEventJob
  | GenerateSessionSummaryJob
  | ReindexObservationJob;

const KIND_TO_JOB_TYPE: Record<SingleSourceJobPayload['kind'], string> = {
  event: 'observation_generate_for_event',
  summary: 'observation_generate_session_summary',
  reindex: 'observation_reindex'
};

export interface OutboxScope {
  projectId: string;
  teamId: string;
}

export interface EnqueueOutboxRowInput {
  payload: SingleSourceJobPayload;
  agentEventId?: string | null;
  serverSessionId?: string | null;
  maxAttempts?: number;
}

// `enqueueOutbox` writes the canonical row first, then publishes to BullMQ.
// If the BullMQ add() throws (for example Redis is unavailable), the row is
// transitioned to `failed` so the next reconciliation pass can resurrect it
// rather than leaving stale `queued` rows that never enter the transport.
export async function enqueueOutbox(
  jobRepo: PostgresObservationGenerationJobRepository,
  eventsRepo: PostgresObservationGenerationJobEventsRepository,
  queue: ServerJobQueue<SingleSourceJobPayload>,
  input: EnqueueOutboxRowInput
): Promise<{ row: PostgresObservationGenerationJob; bullmqJobId: string }> {
  const { payload } = input;
  const bullmqJobId = buildServerJobId({
    kind: payload.kind,
    team_id: payload.team_id,
    project_id: payload.project_id,
    source_type: payload.source_type,
    source_id: payload.source_id
  });

  const row = await jobRepo.create({
    projectId: payload.project_id,
    teamId: payload.team_id,
    sourceType: payload.source_type,
    sourceId: payload.source_id,
    agentEventId: input.agentEventId ?? extractAgentEventId(payload),
    serverSessionId: input.serverSessionId ?? extractServerSessionId(payload),
    jobType: KIND_TO_JOB_TYPE[payload.kind],
    bullmqJobId,
    maxAttempts: input.maxAttempts,
    payload: payload as unknown as JsonObject
  });

  await eventsRepo.append({
    generationJobId: row.id,
    projectId: row.projectId,
    teamId: row.teamId,
    eventType: 'queued',
    statusAfter: row.status,
    attempt: row.attempts
  });

  try {
    // Phase 11 — defense in depth. Validate the payload shape at the queue
    // boundary so a malformed enqueue is rejected synchronously and never
    // produces a job whose audit trail is missing fields.
    assertServerGenerationJobPayload(payload);
    await queue.add(bullmqJobId, payload);
    await eventsRepo.append({
      generationJobId: row.id,
      projectId: row.projectId,
      teamId: row.teamId,
      eventType: 'enqueued',
      statusAfter: row.status,
      attempt: row.attempts
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('QUEUE', `failed to publish to BullMQ for job ${row.id}: ${message}`);
    await jobRepo.transitionStatus({
      id: row.id,
      projectId: row.projectId,
      teamId: row.teamId,
      status: 'failed',
      lastError: { message, source: 'bullmq_publish' }
    });
    await eventsRepo.append({
      generationJobId: row.id,
      projectId: row.projectId,
      teamId: row.teamId,
      eventType: 'failed',
      statusAfter: 'failed',
      attempt: row.attempts,
      details: { source: 'bullmq_publish', message }
    });
    throw error;
  }

  return { row, bullmqJobId };
}

// `reconcileOnStartup` re-enqueues outbox rows that were left in `queued` or
// `processing` after a crash or restart. For each row we replace any
// terminal BullMQ job that may still be holding the deterministic ID slot
// (BullMQ refuses to re-add a jobId that already exists in `completed` or
// `failed` lists). Reconciliation is a no-op for rows past max_attempts.
export async function reconcileOnStartup(
  jobRepo: PostgresObservationGenerationJobRepository,
  eventsRepo: PostgresObservationGenerationJobEventsRepository,
  queue: ServerJobQueue<SingleSourceJobPayload>,
  scope: OutboxScope,
  options?: { limit?: number }
): Promise<{ requeued: number; skipped: number }> {
  const limit = options?.limit ?? 500;
  const queued = await jobRepo.listByStatusForScope({
    status: 'queued',
    projectId: scope.projectId,
    teamId: scope.teamId,
    limit
  });
  const processing = await jobRepo.listByStatusForScope({
    status: 'processing',
    projectId: scope.projectId,
    teamId: scope.teamId,
    limit
  });

  let requeued = 0;
  let skipped = 0;

  for (const row of [...processing, ...queued]) {
    if (row.attempts >= row.maxAttempts) {
      skipped += 1;
      continue;
    }

    const bullmqJobId = row.bullmqJobId ?? buildServerJobId(extractIdParts(row));

    try {
      await queue.remove(bullmqJobId);
    } catch (error) {
      logger.debug?.('QUEUE', `remove before re-add ignored for ${bullmqJobId}`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if (row.status === 'processing') {
      await jobRepo.transitionStatus({
        id: row.id,
        projectId: row.projectId,
        teamId: row.teamId,
        status: 'queued'
      });
      await eventsRepo.append({
        generationJobId: row.id,
        projectId: row.projectId,
        teamId: row.teamId,
        eventType: 'queued',
        statusAfter: 'queued',
        attempt: row.attempts,
        details: { source: 'reconcile_on_startup' }
      });
    }

    await queue.add(bullmqJobId, row.payload as unknown as SingleSourceJobPayload);
    await eventsRepo.append({
      generationJobId: row.id,
      projectId: row.projectId,
      teamId: row.teamId,
      eventType: 'enqueued',
      statusAfter: 'queued',
      attempt: row.attempts,
      details: { source: 'reconcile_on_startup' }
    });
    requeued += 1;
  }

  return { requeued, skipped };
}

export async function markCompleted(
  jobRepo: PostgresObservationGenerationJobRepository,
  eventsRepo: PostgresObservationGenerationJobEventsRepository,
  input: { id: string; projectId: string; teamId: string; details?: JsonObject }
): Promise<void> {
  const updated = await jobRepo.transitionStatus({
    id: input.id,
    projectId: input.projectId,
    teamId: input.teamId,
    status: 'completed'
  });
  if (!updated) {
    throw new Error(`generation job ${input.id} not found for scope`);
  }
  await eventsRepo.append({
    generationJobId: updated.id,
    projectId: updated.projectId,
    teamId: updated.teamId,
    eventType: 'completed',
    statusAfter: 'completed',
    attempt: updated.attempts,
    details: input.details ?? {}
  });
}

export async function markFailed(
  jobRepo: PostgresObservationGenerationJobRepository,
  eventsRepo: PostgresObservationGenerationJobEventsRepository,
  input: {
    id: string;
    projectId: string;
    teamId: string;
    error: { message: string; source?: string };
    nextAttemptAt?: Date | null;
  }
): Promise<void> {
  const status = input.nextAttemptAt ? 'queued' : 'failed';
  const updated = await jobRepo.transitionStatus({
    id: input.id,
    projectId: input.projectId,
    teamId: input.teamId,
    status,
    nextAttemptAt: input.nextAttemptAt ?? null,
    lastError: { message: input.error.message, source: input.error.source ?? 'processor' }
  });
  if (!updated) {
    throw new Error(`generation job ${input.id} not found for scope`);
  }
  await eventsRepo.append({
    generationJobId: updated.id,
    projectId: updated.projectId,
    teamId: updated.teamId,
    eventType: status === 'queued' ? 'retry_scheduled' : 'failed',
    statusAfter: status,
    attempt: updated.attempts,
    details: { message: input.error.message, source: input.error.source ?? 'processor' }
  });
}

function extractAgentEventId(payload: SingleSourceJobPayload): string | null {
  return payload.kind === 'event' ? payload.agent_event_id : null;
}

function extractServerSessionId(payload: SingleSourceJobPayload): string | null {
  return payload.kind === 'summary' ? payload.server_session_id : null;
}

function extractIdParts(row: PostgresObservationGenerationJob): {
  kind: ServerGenerationJobKind;
  team_id: string;
  project_id: string;
  source_type: string;
  source_id: string;
} {
  const kind = jobTypeToKind(row.jobType);
  return {
    kind,
    team_id: row.teamId,
    project_id: row.projectId,
    source_type: row.sourceType,
    source_id: row.sourceId
  };
}

function jobTypeToKind(jobType: string): ServerGenerationJobKind {
  for (const [kind, type] of Object.entries(KIND_TO_JOB_TYPE) as Array<
    [SingleSourceJobPayload['kind'], string]
  >) {
    if (type === jobType) {
      return kind;
    }
  }
  throw new Error(`unknown observation generation job_type: ${jobType}`);
}
