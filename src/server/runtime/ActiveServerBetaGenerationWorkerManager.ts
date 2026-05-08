// SPDX-License-Identifier: Apache-2.0

import type { Job } from 'bullmq';
import { logger } from '../../utils/logger.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { ProviderObservationGenerator } from '../generation/ProviderObservationGenerator.js';
import type { ServerGenerationProvider } from '../generation/providers/shared/types.js';
import type { ServerGenerationJobPayload } from '../jobs/types.js';
import type { ActiveServerBetaQueueManager } from './ActiveServerBetaQueueManager.js';
import type {
  ServerBetaBoundaryHealth,
  ServerBetaGenerationWorkerManager,
} from './types.js';

// ActiveServerBetaGenerationWorkerManager wires a BullMQ Worker (per the
// 'event' queue) to a ProviderObservationGenerator. Concurrency defaults to
// 1 per the plan (line 80–86) so retries observe a single inflight provider
// call per server. autorun:false / explicit run() is enforced by
// ServerJobQueue.start.
//
// This class is wired in only when both a queue manager AND a configured
// provider are present. create-server-beta-service keeps the disabled
// adapter otherwise so server beta can boot without provider credentials.

export interface ActiveServerBetaGenerationWorkerManagerOptions {
  pool: PostgresPool;
  queueManager: ActiveServerBetaQueueManager;
  provider: ServerGenerationProvider;
  workerId?: string;
  // Test seam: replace the generator with a stub.
  generatorFactory?: (
    pool: PostgresPool,
    provider: ServerGenerationProvider,
    workerId: string,
  ) => ProviderObservationGenerator;
}

export class ActiveServerBetaGenerationWorkerManager implements ServerBetaGenerationWorkerManager {
  readonly kind = 'generation-worker-manager' as const;
  private started = false;
  private closed = false;
  private readonly generator: ProviderObservationGenerator;
  private readonly workerId: string;

  constructor(private readonly options: ActiveServerBetaGenerationWorkerManagerOptions) {
    this.workerId = options.workerId ?? `server-beta-${process.pid}`;
    this.generator = options.generatorFactory
      ? options.generatorFactory(options.pool, options.provider, this.workerId)
      : new ProviderObservationGenerator({
          pool: options.pool,
          provider: options.provider,
          workerId: this.workerId,
        });
  }

  /**
   * Attach BullMQ Worker to the 'event' queue. Per BullMQ docs we use
   *   new Worker(queueName, processor, { concurrency, autorun })
   * via ServerJobQueue.start(...). Errors are surfaced through the queue
   * wrapper's worker.on('error', ...) listener.
   */
  start(): void {
    if (this.started) return;
    const dispatcher = async (job: Job<ServerGenerationJobPayload>) => {
      try {
        return await this.generator.process(job);
      } catch (error) {
        logger.warn('SYSTEM', 'observation generator failed', {
          jobId: job.id,
          kind: job.data.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    this.options.queueManager.start('event', dispatcher);
    // Phase 6: wire the summary lane alongside the event lane. Concurrency
    // defaults to 1 per ServerJobQueue config (per the plan), and the same
    // ProviderObservationGenerator dispatches on job.data.source_type via the
    // outbox row reload inside lockOutbox+process.
    this.options.queueManager.start('summary', dispatcher);

    // Phase 12 — audit stalled events directly. Phase 11's audit chain now
    // covers the operator and provider lifecycle; stalled jobs come from
    // BullMQ runtime not the HTTP boundary, so we wire them in here. Best-
    // effort: a missing/unscoped audit MUST NOT crash the worker.
    for (const lane of ['event', 'summary'] as const) {
      try {
        const queue = this.options.queueManager.getQueue(lane);
        queue.observe({
          onStalled: (jobId) => {
            void this.auditStalledJob(jobId, lane);
          },
        });
      } catch (error) {
        logger.warn('SYSTEM', `failed to wire stalled observer for ${lane} lane`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.started = true;
  }

  // Phase 12 — write a `generation_job.stalled` audit row. We look up the
  // outbox row by BullMQ jobId (== bullmq_job_id column) so team/project
  // scope is correct on the audit row even when the original API key
  // metadata is unavailable (BullMQ retries can outlive a session).
  private async auditStalledJob(bullmqJobId: string, lane: 'event' | 'summary'): Promise<void> {
    try {
      const result = await this.options.pool.query<{
        id: string;
        team_id: string | null;
        project_id: string | null;
      }>(
        'SELECT id, team_id, project_id FROM observation_generation_jobs WHERE bullmq_job_id = $1 LIMIT 1',
        [bullmqJobId],
      );
      const row = result.rows[0];
      if (!row) return;
      const repo = new PostgresAuthRepository(this.options.pool);
      await repo.createAuditLog({
        teamId: row.team_id,
        projectId: row.project_id,
        actorId: null,
        apiKeyId: null,
        action: 'generation_job.stalled',
        resourceType: 'observation_generation_job',
        resourceId: row.id,
        details: { lane, bullmqJobId },
      });
    } catch (error) {
      logger.warn('SYSTEM', 'failed to audit stalled generation_job', {
        bullmqJobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getHealth(): ServerBetaBoundaryHealth {
    if (this.closed) {
      return { status: 'errored', reason: 'generation-worker-manager closed' };
    }
    return {
      status: this.started ? 'active' : 'disabled',
      reason: this.started
        ? 'BullMQ Worker attached to event queue with ProviderObservationGenerator'
        : 'wired but not started',
      details: {
        provider: this.options.provider.providerLabel,
        workerId: this.workerId,
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // The underlying Worker is owned by ServerJobQueue.close() (driven by
    // the queue manager). We do not double-close here; the queue manager's
    // close cascade handles it.
  }
}
