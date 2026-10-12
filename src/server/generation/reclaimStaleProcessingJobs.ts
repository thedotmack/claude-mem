// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../utils/logger.js';
import {
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
  type PostgresObservationGenerationJob,
} from '../../storage/postgres/generation-jobs.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';

// A worker that dies between lockOutbox and its terminal transition leaves the
// outbox row in `processing` for good: BullMQ's stalled redelivery reaches
// lockOutbox, which skips a `processing` row, and POST /v1/jobs/:id/retry
// refuses one with 409. This sweep is the reconcile those code paths assume.
// A row whose lock is older than `staleAfterMs` goes back to `queued` and is
// republished, or to `failed` once it has used every attempt, so a job that
// kills its worker every time still ends.

export interface ReclaimQueue {
  add(jobId: string, payload: never): Promise<unknown>;
  remove(jobId: string): Promise<unknown>;
}

export interface ReclaimStaleProcessingJobsOptions {
  pool: PostgresQueryable;
  staleAfterMs: number;
  resolveQueue: (lane: 'event' | 'summary') => ReclaimQueue | null;
  limit?: number;
}

export interface ReclaimResult {
  requeued: number;
  failed: number;
}

export async function reclaimStaleProcessingJobs(
  options: ReclaimStaleProcessingJobsOptions,
): Promise<ReclaimResult> {
  const repo = new PostgresObservationGenerationJobRepository(options.pool);
  // Selected and moved in one lock-checked statement, so two sweepers (or a
  // worker re-locking the row meanwhile) can't both act on the same row.
  const reclaimed = await repo.reclaimStaleProcessing({
    staleAfterMs: options.staleAfterMs,
    limit: options.limit,
  });
  const result: ReclaimResult = { requeued: 0, failed: 0 };
  for (const { job, previousLockedBy, previousLockedAtEpoch } of reclaimed) {
    const lock = { lockedBy: previousLockedBy, lockedAtEpoch: previousLockedAtEpoch };
    let target: 'queued' | 'failed' = job.status === 'failed' ? 'failed' : 'queued';
    // Publish first: an audit-row failure must never leave a queued row with
    // no BullMQ job behind it.
    if (target === 'queued' && !(await republish(job, repo, options))) {
      target = 'failed';
    }
    await appendReclaimEvent(job, target, lock, options);
    if (target === 'queued') result.requeued += 1;
    else result.failed += 1;
  }
  if (reclaimed.length > 0) {
    logger.warn('SYSTEM', 'reclaimed generation jobs stuck in processing', {
      found: reclaimed.length,
      ...result,
      staleAfterMs: options.staleAfterMs,
    });
  }
  return result;
}

async function appendReclaimEvent(
  job: PostgresObservationGenerationJob,
  target: 'queued' | 'failed',
  lock: { lockedBy: string | null; lockedAtEpoch: number | null },
  options: ReclaimStaleProcessingJobsOptions,
): Promise<void> {
  try {
    await new PostgresObservationGenerationJobEventsRepository(options.pool).append({
      generationJobId: job.id,
      projectId: job.projectId,
      teamId: job.teamId,
      eventType: target,
      statusAfter: target,
      attempt: job.attempts,
      details: { source: 'stale_lock_reclaim', ...lock },
    });
  } catch (error) {
    logger.warn('SYSTEM', 'failed to record reclaimed generation job event', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Returns false when the job could not be put back on BullMQ. The row is then
// moved queued -> failed, which the operator retry route accepts, instead of
// sitting in `queued` with nothing to deliver it (later sweeps only look at
// `processing`).
async function republish(
  job: PostgresObservationGenerationJob,
  repo: PostgresObservationGenerationJobRepository,
  options: ReclaimStaleProcessingJobsOptions,
): Promise<boolean> {
  const queue = options.resolveQueue(job.sourceType === 'session_summary' ? 'summary' : 'event');
  let failure: string | null = null;
  if (!queue || !job.bullmqJobId) {
    failure = !queue ? 'no queue for lane' : 'job has no bullmq_job_id';
  } else {
    try {
      // The finished or failed BullMQ entry still holds this jobId; adding over
      // it would be a no-op.
      try { await queue.remove(job.bullmqJobId); } catch { /* already gone */ }
      await queue.add(job.bullmqJobId, job.payload as never);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  if (failure === null) return true;

  logger.warn('SYSTEM', 'failed to republish reclaimed generation job; marking it failed', {
    jobId: job.id,
    error: failure,
  });
  try {
    await repo.transitionStatus({
      id: job.id,
      projectId: job.projectId,
      teamId: job.teamId,
      status: 'failed',
      lastError: { reason: 'reclaim_republish_failed', error: failure },
    });
  } catch (error) {
    logger.warn('SYSTEM', 'failed to mark unpublished reclaimed generation job failed', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}
