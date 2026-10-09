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
  const stale = await repo.listStaleProcessing({
    olderThanMs: options.staleAfterMs,
    limit: options.limit,
  });
  const result: ReclaimResult = { requeued: 0, failed: 0 };
  for (const job of stale) {
    const outcome = await reclaimOne(job, repo, options);
    if (outcome === 'queued') result.requeued += 1;
    if (outcome === 'failed') result.failed += 1;
  }
  if (stale.length > 0) {
    logger.warn('SYSTEM', 'reclaimed generation jobs stuck in processing', {
      found: stale.length,
      ...result,
      staleAfterMs: options.staleAfterMs,
    });
  }
  return result;
}

async function reclaimOne(
  job: PostgresObservationGenerationJob,
  repo: PostgresObservationGenerationJobRepository,
  options: ReclaimStaleProcessingJobsOptions,
): Promise<'queued' | 'failed' | 'skipped'> {
  const target = job.attempts >= job.maxAttempts ? 'failed' : 'queued';
  const lock = { lockedBy: job.lockedBy, lockedAtEpoch: job.lockedAtEpoch };
  try {
    await repo.transitionStatus({
      id: job.id,
      projectId: job.projectId,
      teamId: job.teamId,
      status: target,
      lastError: target === 'failed' ? { reason: 'stale_processing_lock', ...lock } : null,
    });
  } catch (error) {
    // The row left `processing` between the read and the update: a worker
    // finished it after all. Its own transition stands.
    logger.debug('SYSTEM', 'stale generation job changed before reclaim; leaving it', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'skipped';
  }
  await new PostgresObservationGenerationJobEventsRepository(options.pool).append({
    generationJobId: job.id,
    projectId: job.projectId,
    teamId: job.teamId,
    eventType: target,
    statusAfter: target,
    attempt: job.attempts,
    details: { source: 'stale_lock_reclaim', ...lock },
  });
  if (target === 'queued') {
    await republish(job, options);
  }
  return target;
}

async function republish(
  job: PostgresObservationGenerationJob,
  options: ReclaimStaleProcessingJobsOptions,
): Promise<void> {
  const queue = options.resolveQueue(job.sourceType === 'session_summary' ? 'summary' : 'event');
  if (!queue || !job.bullmqJobId) return;
  try {
    // The finished or failed BullMQ entry still holds this jobId; adding over
    // it would be a no-op.
    try { await queue.remove(job.bullmqJobId); } catch { /* already gone */ }
    await queue.add(job.bullmqJobId, job.payload as never);
  } catch (error) {
    logger.warn('SYSTEM', 'failed to republish reclaimed generation job', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
